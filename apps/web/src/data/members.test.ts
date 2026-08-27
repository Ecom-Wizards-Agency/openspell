import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { claimInvitation, createInvitation, hashInviteToken } from './invitations';
import { addMember, listMembers, removeMember, updateMemberRole } from './members';

const available = await databaseAvailable();

describe.skipIf(!available)('membership mutations', () => {
  let database: TestDatabase;
  let orgId: string;
  const ownerId = '38383838-3838-4838-8838-383838383839';

  beforeAll(async () => {
    database = await createTestDatabase('web_members');
    const rows = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('member-test', ${ownerId}, 'owner')
    `;
    orgId = rows[0]?.seed_tenant_fixture ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('adds an accepted invitee and records the acceptance audit', async () => {
    const userId = randomUUID();
    const email = `member-${randomUUID()}@example.test`;
    await database.sql`select public.auth_user_stub(${userId})`;
    await database.sql`update auth.users set email = ${email} where id = ${userId}`;
    const issued = await createInvitation(database, {
      orgId,
      email,
      role: 'analyst',
      invitedBy: ownerId,
    });
    const claimed = await claimInvitation(database, hashInviteToken(issued.token), userId);
    expect(claimed).not.toBeNull();

    expect(
      await addMember(database, {
        orgId,
        userId,
        role: 'analyst',
        invitationId: issued.invitation.id,
      }),
    ).toBe(1);
    expect((await listMembers(database, orgId)).find((row) => row.userId === userId)?.email).toBe(
      email,
    );
    const audits = await database.sql<{ action: string }[]>`
      select action from public.audit_log
       where org_id = ${orgId} and target_id = ${issued.invitation.id}
       order by id
    `;
    expect(audits.map((row) => row.action)).toEqual([
      'invitation.created',
      'invitation.accepted',
    ]);
  });

  it('returns zero instead of demoting or removing the final owner', async () => {
    expect(
      await updateMemberRole(database, {
        orgId,
        userId: ownerId,
        actorId: ownerId,
        role: 'admin',
      }),
    ).toBe(0);
    expect(await removeMember(database, { orgId, userId: ownerId, actorId: ownerId })).toBe(0);

    const rows = await database.sql<{ role: string }[]>`
      select role::text as role from public.org_members
       where org_id = ${orgId} and user_id = ${ownerId}
    `;
    expect(rows[0]?.role).toBe('owner');
  });
});
