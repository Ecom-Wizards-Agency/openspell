/** Organisation membership reads and invariant-preserving writes. */
import type { Sql } from '@wizard-ads/db';
import { isOrgRole } from '../auth/roles';
import type { OrgRole } from '../auth/roles';

export interface SqlHandle {
  sql: Sql;
}

export interface MemberRecord {
  userId: string;
  email: string | null;
  role: OrgRole;
  createdAt: string;
  updatedAt: string;
}

export interface AddMemberInput {
  orgId: string;
  userId: string;
  role: OrgRole;
  invitationId: string;
}

export interface MemberChangeInput {
  orgId: string;
  userId: string;
  actorId: string;
}

interface MemberRow {
  user_id: string;
  email: string | null;
  role: string;
  created_at: string;
  updated_at: string;
}

export async function listMembers(handle: SqlHandle, orgId: string): Promise<MemberRecord[]> {
  const rows = await handle.sql<MemberRow[]>`
    select m.user_id, u.email, m.role::text as role,
           m.created_at::text as created_at, m.updated_at::text as updated_at
      from public.org_members m
      join auth.users u on u.id = m.user_id
     where m.org_id = ${orgId}
     order by lower(u.email) nulls last, m.created_at
  `;
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: isOrgRole(row.role) ? row.role : 'viewer',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Add membership idempotently, finish a provisional claim, and write the
 * acceptance audit in one transaction. Returns the membership rows inserted.
 */
export async function addMember(handle: SqlHandle, input: AddMemberInput): Promise<number> {
  if (!isOrgRole(input.role)) throw new Error('Unknown organisation role.');
  return handle.sql.begin(async (sql) => {
    const inserted = await sql<{ user_id: string }[]>`
      insert into public.org_members (org_id, user_id, role)
      values (${input.orgId}, ${input.userId}, ${input.role})
      on conflict (org_id, user_id) do nothing
      returning user_id
    `;

    const completed = await sql<{ id: string }[]>`
      update public.org_invitations
         set accepted_by = ${input.userId}
       where id = ${input.invitationId}
         and org_id = ${input.orgId}
         and accepted_at is not null
         and (accepted_by is null or accepted_by = ${input.userId})
      returning id
    `;
    if (completed.length !== 1) throw new Error('The invitation claim could not be completed.');

    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values
        (${input.orgId}, 'user', ${input.userId}, 'invitation.accepted',
         'org_invitation', ${input.invitationId},
         jsonb_build_object('role', ${input.role}), 'web')
    `;
    return inserted.length;
  });
}

/** Change a role unless that would remove the org's final owner. */
export async function updateMemberRole(
  handle: SqlHandle,
  input: MemberChangeInput & { role: OrgRole },
): Promise<number> {
  if (!isOrgRole(input.role)) throw new Error('Unknown organisation role.');
  return handle.sql.begin(async (sql) => {
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`org-members\0${input.orgId}`}, 0))
    `;
    const current = await sql<{ role: string }[]>`
      select role::text as role from public.org_members
       where org_id = ${input.orgId} and user_id = ${input.userId}
       for update
    `;
    const oldRole = current[0]?.role;
    if (oldRole === undefined || oldRole === input.role) return 0;
    const changed = await sql<{ user_id: string }[]>`
      update public.org_members set role = ${input.role}
       where org_id = ${input.orgId}
         and user_id = ${input.userId}
         and (
           role <> 'owner'
           or ${input.role}::public.org_role = 'owner'
           or exists (
             select 1 from public.org_members other
              where other.org_id = ${input.orgId}
                and other.user_id <> ${input.userId}
                and other.role = 'owner'
           )
         )
      returning user_id
    `;
    if (changed.length !== 1) return 0;
    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values
        (${input.orgId}, 'user', ${input.actorId}, 'member.role_changed',
         'org_member', ${input.userId},
         jsonb_build_object('from', ${oldRole}, 'to', ${input.role}), 'web')
    `;
    return 1;
  });
}

/** Remove a member unless that row is the org's final owner. */
export async function removeMember(handle: SqlHandle, input: MemberChangeInput): Promise<number> {
  return handle.sql.begin(async (sql) => {
    await sql`
      select pg_advisory_xact_lock(hashtextextended(${`org-members\0${input.orgId}`}, 0))
    `;
    const current = await sql<{ role: string }[]>`
      select role::text as role from public.org_members
       where org_id = ${input.orgId} and user_id = ${input.userId}
       for update
    `;
    const oldRole = current[0]?.role;
    if (oldRole === undefined) return 0;
    const changed = await sql<{ user_id: string }[]>`
      delete from public.org_members
       where org_id = ${input.orgId}
         and user_id = ${input.userId}
         and (
           role <> 'owner'
           or exists (
             select 1 from public.org_members other
              where other.org_id = ${input.orgId}
                and other.user_id <> ${input.userId}
                and other.role = 'owner'
           )
         )
      returning user_id
    `;
    if (changed.length !== 1) return 0;
    await sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values
        (${input.orgId}, 'user', ${input.actorId}, 'member.removed',
         'org_member', ${input.userId}, jsonb_build_object('role', ${oldRole}), 'web')
    `;
    return 1;
  });
}
