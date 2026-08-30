/**
 * The complete Grid's narrow authentication and authorization boundary.
 *
 * Page authentication resolves a user, every membership, and an active org for
 * navigation. The rows API needs less information and sits on a hot path, so it
 * verifies only the session subject and resolves membership, active org,
 * profile ownership, role, and currency in one database statement.
 */
import type { RequestDatabase } from '@wizard-ads/db';
import type { OrgRole } from '../auth/roles';
import { isOrgRole } from '../auth/roles';
import { ORG_COOKIE } from '../cookies';
import {
  actorFromHeaders,
  e2eAuthBridgeEnabled,
  openWebDatabase,
  RequestAuthError,
} from '../server/request-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GridRequestSubject =
  | { userId: string; organization: { mode: 'exact'; orgId: string } }
  | { userId: string; organization: { mode: 'preferred'; orgId: string | null } };

export interface GridReadReceipt {
  orgId: string;
  role: OrgRole;
  /** Null means the selected organization cannot see the candidate profile. */
  profileId: string | null;
  /** Server-owned and therefore null whenever `profileId` is null. */
  currencyCode: string | null;
}

export interface AuthorizedGridRequest {
  database: RequestDatabase;
  receipt: GridReadReceipt;
}

interface ReceiptRow {
  org_id: string;
  role: string;
  profile_id: string | null;
  currency_code: string | null;
}

interface GridSubjectRuntime {
  verifiedSessionSubject(): Promise<string | null>;
  preferredOrganization(): Promise<string | null>;
}

async function verifiedSessionSubject(): Promise<string | null> {
  // The authenticated browser suite uses the same guarded test-only cookie
  // seam as every Server Component. Keep that seam explicit here: calling
  // Supabase directly would make the page authenticate while this client-side
  // rows request returns 401, leaving the Grid permanently in its loading
  // state. `e2eAuthEnabled` refuses production, so this path cannot weaken a
  // deployed instance.
  const { currentUser, e2eAuthEnabled } = await import('../auth/session');
  if (e2eAuthEnabled()) {
    const user = await currentUser();
    return user !== null && UUID.test(user.id) ? user.id : null;
  }

  const { supabaseConfigured, supabaseServerClient } = await import('../auth/supabase');
  if (!supabaseConfigured()) return null;

  const supabase = await supabaseServerClient();
  // getClaims verifies asymmetric JWTs locally when the cached signing key is
  // available. Supabase Auth deliberately falls back to getUser for symmetric
  // signing or runtimes without WebCrypto, so the subject remains authoritative.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data) return null;
  const subject = data.claims.sub;
  return typeof subject === 'string' && UUID.test(subject) ? subject : null;
}

async function preferredOrganization(): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const value = (await cookies()).get(ORG_COOKIE)?.value ?? null;
  return value !== null && UUID.test(value) ? value : null;
}

const DEFAULT_RUNTIME: GridSubjectRuntime = {
  verifiedSessionSubject,
  preferredOrganization,
};

/**
 * Verify the one identity source permitted in this runtime.
 *
 * The e2e bridge helper refuses to arm beside Supabase Auth and checks its
 * secret before returning ids. Its org is exact: it never falls back to a
 * different membership. A real session carries only a preferred org cookie;
 * the database still decides whether that preference is a membership.
 */
export async function gridRequestSubject(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
  runtime: GridSubjectRuntime = DEFAULT_RUNTIME,
): Promise<GridRequestSubject> {
  if (e2eAuthBridgeEnabled(env)) {
    const actor = actorFromHeaders(headers, env);
    return {
      userId: actor.userId,
      organization: { mode: 'exact', orgId: actor.orgId },
    };
  }

  const userId = await runtime.verifiedSessionSubject();
  if (userId === null || !UUID.test(userId)) {
    throw new RequestAuthError('Authentication required', 401);
  }
  const preferredOrgId = await runtime.preferredOrganization();
  return {
    userId,
    organization: {
      mode: 'preferred',
      orgId: preferredOrgId !== null && UUID.test(preferredOrgId) ? preferredOrgId : null,
    },
  };
}

/** Safely map schema drift to the least-privileged known role. */
export function gridRole(value: string): OrgRole {
  return isOrgRole(value) ? value : 'viewer';
}

/**
 * Resolve the complete membership-fenced receipt in one statement.
 *
 * `candidateProfileId` may be null when query parsing failed. Membership still
 * resolves first so an invalid request cannot be used to probe whether a user
 * has an account. The route applies its 400 before inspecting the nullable
 * profile fields.
 */
export async function resolveGridReadReceipt(
  handle: Pick<RequestDatabase, 'sql'>,
  subject: GridRequestSubject,
  candidateProfileId: string | null,
): Promise<GridReadReceipt> {
  const exact = subject.organization.mode === 'exact';
  const organizationId = subject.organization.orgId;
  const rows = await handle.sql<ReceiptRow[]>`
    with memberships as materialized (
      select m.org_id,
             m.role::text as role,
             o.name as org_name
        from public.org_members m
        join public.orgs o on o.id = m.org_id
       where m.user_id = ${subject.userId}
    ), selected_membership as (
      select org_id, role
        from memberships
       where not ${exact}::boolean
          or org_id = ${organizationId}::uuid
       order by
         case
           when not ${exact}::boolean
            and org_id = ${organizationId}::uuid then 0
           else 1
         end,
         org_name,
         org_id
       limit 1
    )
    select selected.org_id,
           selected.role,
           profile.id as profile_id,
           profile.currency_code::text as currency_code
      from selected_membership selected
      left join public.ad_profiles profile
        on profile.org_id = selected.org_id
       and profile.id = ${candidateProfileId}::uuid
  `;

  const row = rows[0];
  if (row === undefined) throw new RequestAuthError('Resource not found', 403);
  return {
    orgId: row.org_id,
    role: gridRole(row.role),
    profileId: row.profile_id,
    currencyCode: row.currency_code,
  };
}

interface GridRequestAuthorizationAdapters {
  identify: typeof gridRequestSubject;
  openDatabase: typeof openWebDatabase;
  resolveReceipt: typeof resolveGridReadReceipt;
}

interface AuthorizeGridRequestInput {
  headers: Headers;
  candidateProfileId: string | null;
  /** Fixed lifecycle boundary for identifier-free route timing. */
  identityVerified(): void;
}

export type GridRequestAuthorizer = (
  input: AuthorizeGridRequestInput,
) => Promise<AuthorizedGridRequest>;

const DEFAULT_AUTHORIZATION_ADAPTERS: GridRequestAuthorizationAdapters = {
  identify: gridRequestSubject,
  openDatabase: openWebDatabase,
  resolveReceipt: resolveGridReadReceipt,
};

/**
 * Construct the Grid's one deep authorization operation.
 *
 * Identity, database acquisition, and the receipt query stay in one lifecycle
 * so callers cannot reorder them or accidentally use a different database for
 * authorization. Adapters are fixed at construction and exist only for tests;
 * request callers supply no identity or tenant facts.
 */
export function createGridRequestAuthorizer(
  adapters: GridRequestAuthorizationAdapters = DEFAULT_AUTHORIZATION_ADAPTERS,
): GridRequestAuthorizer {
  return async (input): Promise<AuthorizedGridRequest> => {
    const subject = await adapters.identify(input.headers);
    input.identityVerified();

    const database = adapters.openDatabase();
    try {
      const receipt = await adapters.resolveReceipt(
        database,
        subject,
        input.candidateProfileId,
      );
      return { database, receipt };
    } catch (error) {
      // The caller never receives a handle when authorization fails, so this
      // layer owns exactly one close on that path.
      await database.close();
      throw error;
    }
  };
}

export const authorizeGridRequest = createGridRequestAuthorizer();
