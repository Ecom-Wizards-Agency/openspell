/**
 * Organisation invitation lifecycle.
 *
 * The plaintext token leaves this module exactly once, in
 * `createInvitation`'s return value. Every stored/read value is either the
 * SHA-256 digest or a short display prefix. Public lookup is deliberately
 * unscoped because the visitor has no membership yet; after lookup, every
 * mutation carries the row's org id explicitly.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from '@wizard-ads/db';
import { isOrgRole } from '../auth/roles';
import type { OrgRole } from '../auth/roles';

export interface SqlHandle {
  sql: Sql;
}

export type InvitationRole = Exclude<OrgRole, 'owner'>;
export type InvitationStatus = 'pending' | 'expired' | 'revoked' | 'accepted';

const STORED_PREFIX_LENGTH = 12;
const INVITATION_LIFETIME_DAYS = 7;

export interface InvitationRecord {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: InvitationRole;
  tokenPrefix: string;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: InvitationStatus;
}

export interface IssuedInvitation {
  invitation: InvitationRecord;
  /** Plaintext URL token. Shown once, never persisted or retrievable. */
  token: string;
}

export interface CreateInvitationInput {
  orgId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string;
}

interface InvitationRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: string;
  token_prefix: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function invitationStatus(
  invitation: Pick<InvitationRecord, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

function toInvitation(row: InvitationRow, now: Date = new Date()): InvitationRecord {
  const role = isOrgRole(row.role) && row.role !== 'owner' ? row.role : 'viewer';
  const invitation: InvitationRecord = {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    email: row.email,
    role,
    tokenPrefix: row.token_prefix,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: 'pending',
  };
  invitation.status = invitationStatus(invitation, now);
  return invitation;
}

const invitationColumns = (sql: Sql) => sql`
  i.id, i.org_id, o.name as org_name, i.email, i.role::text as role,
  i.token_prefix, i.invited_by, i.expires_at::text as expires_at,
  i.accepted_at::text as accepted_at, i.accepted_by,
  i.revoked_at::text as revoked_at, i.created_at::text as created_at,
  i.updated_at::text as updated_at
`;

/** Create a seven-day invitation, refusing members and live duplicates. */
export async function createInvitation(
  handle: SqlHandle,
  input: CreateInvitationInput,
): Promise<IssuedInvitation> {
  const email = input.email.trim().toLowerCase();
  if (email.length === 0) throw new Error('Enter an email address.');
  const requestedRole: unknown = input.role;
  if (!isOrgRole(requestedRole) || requestedRole === 'owner') {
    throw new Error('Invitations may grant admin, analyst, or viewer access.');
  }

  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const tokenPrefix = token.slice(0, STORED_PREFIX_LENGTH);

  const invitation = await handle.sql.begin(async (sql) => {
    // Serialise create checks per org/email so two tabs cannot both pass the
    // "no live invitation" read before either inserts.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}\0${email}`}, 0))`;

    const members = await sql<{ exists: boolean }[]>`
      select exists (
        select 1
          from public.org_members m
          join auth.users u on u.id = m.user_id
         where m.org_id = ${input.orgId}
           and lower(u.email) = ${email}
      ) as exists
    `;
    if (members[0]?.exists === true) throw new Error('That address is already a member.');

    const pending = await sql<{ exists: boolean }[]>`
      select exists (
        select 1 from public.org_invitations
         where org_id = ${input.orgId}
           and email = ${email}
           and accepted_at is null
           and revoked_at is null
           and expires_at > now()
      ) as exists
    `;
    if (pending[0]?.exists === true) {
      throw new Error('That address already has a pending invitation.');
    }

    const rows = await sql<InvitationRow[]>`
      with inserted as (
        insert into public.org_invitations
          (org_id, email, role, token_prefix, token_hash, invited_by, expires_at)
        values
          (${input.orgId}, ${email}, ${input.role}, ${tokenPrefix}, ${tokenHash},
           ${input.invitedBy}, now() + (${INVITATION_LIFETIME_DAYS} * interval '1 day'))
        returning *
      )
      select ${invitationColumns(handle.sql)}
        from inserted i
        join public.orgs o on o.id = i.org_id
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('The invitation could not be stored.');

    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values
        (${input.orgId}, 'user', ${input.invitedBy}, 'invitation.created',
         'org_invitation', ${row.id},
         jsonb_build_object('email', ${email}, 'role', ${input.role}), 'web')
    `;
    return toInvitation(row);
  });

  return { invitation, token };
}

/** Every currently usable invitation in an org, newest first. */
export async function listPendingInvitations(
  handle: SqlHandle,
  orgId: string,
): Promise<InvitationRecord[]> {
  const rows = await handle.sql<InvitationRow[]>`
    select ${invitationColumns(handle.sql)}
      from public.org_invitations i
      join public.orgs o on o.id = i.org_id
     where i.org_id = ${orgId}
       and i.accepted_at is null
       and i.revoked_at is null
       and i.expires_at > now()
     order by i.created_at desc
  `;
  return rows.map((row) => toInvitation(row));
}

/** Revoke an open invitation. Returns whether one row changed. */
export async function revokeInvitation(
  handle: SqlHandle,
  orgId: string,
  invitationId: string,
  revokedBy: string,
): Promise<boolean> {
  return handle.sql.begin(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      update public.org_invitations
         set revoked_at = now()
       where id = ${invitationId}
         and org_id = ${orgId}
         and accepted_at is null
         and revoked_at is null
         and expires_at > now()
      returning id
    `;
    const row = rows[0];
    if (row === undefined) return false;
    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, source)
      values
        (${orgId}, 'user', ${revokedBy}, 'invitation.revoked',
         'org_invitation', ${row.id}, 'web')
    `;
    return true;
  });
}

/** Public, unscoped lookup. Callers must take org/email/role only from this row. */
export async function findInvitationByTokenHash(
  handle: SqlHandle,
  tokenHash: string,
): Promise<InvitationRecord | null> {
  const rows = await handle.sql<InvitationRow[]>`
    select ${invitationColumns(handle.sql)}
      from public.org_invitations i
      join public.orgs o on o.id = i.org_id
     where i.token_hash = ${tokenHash}
     limit 1
  `;
  return rows[0] === undefined ? null : toInvitation(rows[0]);
}

/**
 * Atomically claim an invitation once. A null `acceptedBy` is the provisional
 * new-user claim made before Supabase Auth has assigned the user's id.
 */
export async function claimInvitation(
  handle: SqlHandle,
  tokenHash: string,
  acceptedBy: string | null = null,
): Promise<InvitationRecord | null> {
  const rows = await handle.sql<InvitationRow[]>`
    with claimed as (
      update public.org_invitations
         set accepted_at = now(), accepted_by = ${acceptedBy}
       where token_hash = ${tokenHash}
         and accepted_at is null
         and revoked_at is null
         and expires_at > now()
      returning *
    )
    select ${invitationColumns(handle.sql)}
      from claimed i
      join public.orgs o on o.id = i.org_id
  `;
  return rows[0] === undefined ? null : toInvitation(rows[0]);
}

/** Reopen only a provisional claim; completed/user-bound claims cannot be undone. */
export async function unclaimInvitation(
  handle: SqlHandle,
  invitationId: string,
): Promise<boolean> {
  const rows = await handle.sql<{ id: string }[]>`
    update public.org_invitations
       set accepted_at = null, accepted_by = null
     where id = ${invitationId}
       and accepted_at is not null
       and accepted_by is null
    returning id
  `;
  return rows.length === 1;
}
