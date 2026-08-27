/** `/settings/members` — invitation issuance and the organisation roster. */
import type { ReactNode } from 'react';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { listPendingInvitations } from '../../../src/data/invitations';
import { listMembers } from '../../../src/data/members';
import { gateMessage } from '../../../src/ui/gate-message';
import { Banner, PageHeader } from '../../../src/ui/primitives';
import { Shell } from '../../../src/ui/shell';
import { page } from '../../../src/ui/tokens';
import { MembersManager } from './manager';

export const dynamic = 'force-dynamic';

export default async function MembersPage(): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Members" />
        <Banner tone="warn">{gateMessage(entry.state)}</Banner>
      </main>
    );
  }

  const { handle, context } = entry;
  const active = context.active;
  if (!active) return null;

  if (!can(active.role, 'manageMembers')) {
    return (
      <main style={page}>
        <Shell context={context} current="members">
          <PageHeader
            title="Members"
            subtitle="Invite people, assign access, and keep organisation ownership explicit."
          />
          <Banner tone="warn" data-testid="members-forbidden">
            Members are managed by admins and owners. Your role is <strong>{active.role}</strong>.
          </Banner>
        </Shell>
      </main>
    );
  }

  const [members, invitations] = await Promise.all([
    listMembers(handle, active.orgId),
    listPendingInvitations(handle, active.orgId),
  ]);

  return (
    <main style={page}>
      <Shell context={context} current="members">
        <PageHeader
          title="Members"
          subtitle="Invite people, assign access, and keep organisation ownership explicit."
        />
        <MembersManager
          actor={{ id: context.user.id, role: active.role }}
          members={members}
          invitations={invitations}
        />
      </Shell>
    </main>
  );
}
