/** Public invitation acceptance. Deliberately does not use the membership gate. */
import type { ReactNode } from 'react';
import { currentUser } from '../../../src/auth/session';
import { database } from '../../../src/data/db';
import { findInvitationByTokenHash, hashInviteToken } from '../../../src/data/invitations';
import { Button, Card, Field, Input, LinkButton } from '../../../src/ui/primitives';
import { heading, muted, page } from '../../../src/ui/tokens';
import { acceptAsExistingUser, acceptAsNewUser } from './actions';

export const dynamic = 'force-dynamic';

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  const { token } = await params;
  const { error } = await searchParams;
  const handle = database();
  if (handle === null) return <Outcome>Invitation acceptance is not configured.</Outcome>;

  const invitation = await findInvitationByTokenHash(handle, hashInviteToken(token));
  if (invitation === null) return <Outcome>This invitation is invalid.</Outcome>;
  if (invitation.status === 'expired') return <Outcome>This invitation has expired.</Outcome>;
  if (invitation.status !== 'pending') return <Outcome>This invitation is no longer open.</Outcome>;

  const user = await currentUser();
  const invitePath = `/invite/${encodeURIComponent(token)}`;
  const action = acceptAsExistingUser.bind(null, token);

  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <h1 style={heading}>Join {invitation.orgName}</h1>
      <p style={muted}>
        You have been invited as <strong>{invitation.role}</strong>.
      </p>
      {error ? <p className="wa-banner wa-banner--bad">{error}</p> : null}

      {user !== null ? (
        user.email !== null && user.email.toLowerCase() === invitation.email.toLowerCase() ? (
          <Card>
            <p style={{ marginTop: 0 }}>
              Join {invitation.orgName} as {invitation.role} using {invitation.email}.
            </p>
            <form action={action}>
              <Button type="submit" variant="primary">
                Accept invitation
              </Button>
            </form>
          </Card>
        ) : (
          <Card>
            <p style={{ marginTop: 0 }}>This invitation was issued to a different address.</p>
            <form action={`/auth/signout?next=${encodeURIComponent(invitePath)}`} method="post">
              <Button type="submit" variant="ghost">
                Sign out
              </Button>
            </form>
          </Card>
        )
      ) : (
        <Card>
          <form
            action={acceptAsNewUser.bind(null, token)}
            style={{ display: 'grid', gap: '0.75rem' }}
          >
            <Field label="Email" htmlFor="invite-email">
              <Input
                id="invite-email"
                name="email"
                type="email"
                value={invitation.email}
                readOnly
                aria-readonly="true"
              />
            </Field>
            <Field
              label="Password"
              htmlFor="invite-password"
              hint="Use at least 10 characters."
            >
              <Input
                id="invite-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={10}
                required
              />
            </Field>
            <Button type="submit" variant="primary">
              Create account and join
            </Button>
          </form>
          <p className="wa-hint" style={{ marginBottom: 0, marginTop: '1rem' }}>
            Already have an account?{' '}
            <LinkButton
              href={`/login?next=${encodeURIComponent(invitePath)}`}
              variant="ghost"
              size="sm"
            >
              Sign in first
            </LinkButton>
          </p>
        </Card>
      )}
    </main>
  );
}

function Outcome({ children }: { children: ReactNode }): ReactNode {
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <p style={{ ...muted, margin: 0 }}>{children}</p>
    </main>
  );
}
