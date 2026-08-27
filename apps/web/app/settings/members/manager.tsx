'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ORG_ROLES } from '../../../src/auth/roles';
import type { OrgRole } from '../../../src/auth/roles';
import type { InvitationRecord } from '../../../src/data/invitations';
import type { MemberRecord } from '../../../src/data/members';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  TableFrame,
} from '../../../src/ui/primitives';
import {
  changeMemberRole,
  createInvite,
  removeOrgMember,
  revokeInvite,
} from './actions';
import type { InviteActionResult, MemberActionResult } from './actions';

const IDLE: MemberActionResult = { status: 'idle' };
const IDLE_INVITE: InviteActionResult = { status: 'idle' };

export function MembersManager({
  actor,
  members,
  invitations,
}: {
  actor: { id: string; role: OrgRole };
  members: readonly MemberRecord[];
  invitations: readonly InvitationRecord[];
}): ReactNode {
  const ownerCount = members.filter((member) => member.role === 'owner').length;
  const invitedBy = new Map(members.map((member) => [member.userId, member.email ?? 'Unknown member']));

  return (
    <div className="wa-stack">
      <InviteForm />

      <Card
        title="Members"
        subtitle={`${members.length} ${members.length === 1 ? 'person' : 'people'} with access`}
        flush
      >
        {members.length === 0 ? (
          <EmptyState
            title="No members"
            body="This organisation has no roster rows. Restore an owner before making other changes."
          />
        ) : (
          <TableFrame>
            <table className="wa-table wa-table--numeric">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col"><span className="wa-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    actor={actor}
                    member={member}
                    soleOwner={member.role === 'owner' && ownerCount === 1}
                  />
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Card>

      <Card
        title="Pending invitations"
        subtitle={`${invitations.length} open`}
        flush
      >
        {invitations.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            body="New invitations appear here until they are accepted, revoked, or expire."
          />
        ) : (
          <TableFrame>
            <table className="wa-table wa-table--numeric">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Token</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Invited by</th>
                  <th scope="col"><span className="wa-sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    inviter={
                      invitation.invitedBy === null
                        ? '—'
                        : invitedBy.get(invitation.invitedBy) ?? 'Former member'
                    }
                  />
                ))}
              </tbody>
            </table>
          </TableFrame>
        )}
      </Card>
    </div>
  );
}

function InviteForm(): ReactNode {
  const [result, action, pending] = useActionState(createInvite, IDLE_INVITE);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (result.status === 'ok') {
      formRef.current?.reset();
      setCopied(false);
    }
  }, [result]);

  const visibleUrl = result.status === 'ok' && dismissedUrl !== result.inviteUrl;

  return (
    <Card
      title="Invite someone"
      subtitle="Links stay open for seven days and can be used once."
    >
      <form
        ref={formRef}
        action={action}
        className="wa-row"
        style={{ alignItems: 'flex-end', gap: '0.75rem' }}
      >
        <Field label="Email" htmlFor="invite-email" grow>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="person@example.com"
            required
            disabled={pending}
          />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select id="invite-role" name="role" defaultValue="viewer" disabled={pending}>
            <option value="viewer">Viewer</option>
            <option value="analyst">Analyst</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending} data-testid="create-invite">
          {pending ? 'Inviting…' : 'Invite'}
        </Button>
      </form>

      {result.status === 'error' ? (
        <Banner tone="bad" role="alert" data-testid="invite-error">
          {result.message}
        </Banner>
      ) : null}

      {visibleUrl && result.status === 'ok' ? (
        <div className="wa-banner wa-banner--good" style={{ display: 'block', marginTop: '0.75rem' }}>
          <strong>Copy this invitation link now.</strong> This link will not be shown again.
          <div className="wa-row" style={{ marginTop: '0.5rem' }}>
            <code
              data-testid="invite-url"
              style={{ flex: '1 1 24rem', overflowWrap: 'anywhere' }}
            >
              {result.inviteUrl}
            </code>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(result.inviteUrl).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissedUrl(result.inviteUrl)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function MemberRow({
  actor,
  member,
  soleOwner,
}: {
  actor: { id: string; role: OrgRole };
  member: MemberRecord;
  soleOwner: boolean;
}): ReactNode {
  const [roleResult, roleAction, rolePending] = useActionState(changeMemberRole, IDLE);
  const [removeResult, removeAction, removePending] = useActionState(removeOrgMember, IDLE);
  const actorOwns = actor.role === 'owner';
  const mayEditRole = !soleOwner && (member.role !== 'owner' || actorOwns);
  const mayRemove =
    member.userId !== actor.id && !soleOwner && (member.role !== 'owner' || actorOwns);
  const result = removeResult.status !== 'idle' ? removeResult : roleResult;

  return (
    <tr data-testid="member-row" data-user-id={member.userId}>
      <td>
        {member.email ?? 'Email unavailable'}
        {member.userId === actor.id ? <Badge tone="info">you</Badge> : null}
      </td>
      <td>
        {mayEditRole ? (
          <form action={roleAction} className="wa-row">
            <input type="hidden" name="userId" value={member.userId} />
            <Select
              compact
              name="role"
              defaultValue={member.role}
              aria-label={`Role for ${member.email ?? member.userId}`}
              data-testid="member-role"
              disabled={rolePending}
              style={{ width: '8rem' }}
            >
              {ORG_ROLES.filter((role) => actorOwns || role !== 'owner').map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </Select>
            <Button type="submit" size="sm" disabled={rolePending}>
              Save role
            </Button>
          </form>
        ) : (
          <span data-testid="member-role-locked">
            <Badge tone={member.role === 'owner' ? 'info' : 'neutral'}>{member.role}</Badge>
            {soleOwner ? <span className="wa-hint"> final owner</span> : null}
          </span>
        )}
      </td>
      <td>{shortDate(member.createdAt)}</td>
      <td>
        {mayRemove ? (
          <form action={removeAction}>
            <input type="hidden" name="userId" value={member.userId} />
            <Button
              type="submit"
              size="sm"
              variant="danger"
              disabled={removePending}
              data-testid="remove-member"
            >
              Remove
            </Button>
          </form>
        ) : (
          <span className="wa-hint">
            {member.userId === actor.id ? 'Current session' : 'Owner protected'}
          </span>
        )}
        {result.status === 'idle' ? null : (
          <span
            className={`wa-hint${result.status === 'error' ? ' wa-text-bad' : ''}`}
            role={result.status === 'error' ? 'alert' : 'status'}
            style={{ display: 'block', marginTop: '0.25rem' }}
          >
            {result.message}
          </span>
        )}
      </td>
    </tr>
  );
}

function InvitationRow({
  invitation,
  inviter,
}: {
  invitation: InvitationRecord;
  inviter: string;
}): ReactNode {
  const [result, action, pending] = useActionState(revokeInvite, IDLE);
  return (
    <tr data-testid="invite-row" data-invitation-id={invitation.id}>
      <td>{invitation.email}</td>
      <td><Badge>{invitation.role}</Badge></td>
      <td><code>{invitation.tokenPrefix}…</code></td>
      <td>{shortDate(invitation.expiresAt)}</td>
      <td>{inviter}</td>
      <td>
        <form action={action}>
          <input type="hidden" name="invitationId" value={invitation.id} />
          <Button
            type="submit"
            size="sm"
            variant="danger"
            disabled={pending}
            data-testid="revoke-invite"
          >
            Revoke
          </Button>
        </form>
        {result.status === 'idle' ? null : (
          <span
            className="wa-hint"
            role={result.status === 'error' ? 'alert' : 'status'}
            style={{ display: 'block', marginTop: '0.25rem' }}
          >
            {result.message}
          </span>
        )}
      </td>
    </tr>
  );
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}
