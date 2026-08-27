/**
 * The settings sub-frame: which admin screen you are on, and which tenant it is
 * about.
 *
 * It used to be a second header carrying its own navigation *and* its own sign
 * out button, competing with the application frame directly above it. The frame
 * now owns identity, so this owns exactly what the frame cannot: the tenant this
 * particular screen is reading, the role that decides what it will let you do,
 * and the tabs between the admin screens.
 *
 * A server component. The org switcher is a plain form posting to a server
 * action rather than a client-side select, because a page that already renders
 * per-org on the server does not need hydration to change one cookie.
 */
import type { ReactNode } from 'react';
import type { OrgContext } from '../data/orgs';
import { selectOrg } from './actions';
import { Badge, Button, Select, Tabs } from './primitives';

// Feedback and Roadmap deliberately do NOT appear here. They live in the
// sidebar's PRODUCT group and were duplicated as Settings tabs; WP-24 removes
// the duplicate so each surface has exactly one home in the nav.
const TABS = [
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/profiles', label: 'Profiles' },
  { href: '/settings/members', label: 'Members' },
  { href: '/settings/account', label: 'Account' },
  { href: '/sync-status', label: 'Sync status' },
] as const;

const HREF_FOR = {
  connections: '/settings/connections',
  profiles: '/settings/profiles',
  members: '/settings/members',
  account: '/settings/account',
  sync: '/sync-status',
} as const;

export function Shell({
  context,
  current,
  children,
}: {
  context: OrgContext;
  current: keyof typeof HREF_FOR;
  children: ReactNode;
}): ReactNode {
  const role = context.active?.role ?? null;
  return (
    <>
      <div
        className="wa-row"
        style={{ justifyContent: 'space-between', marginBottom: '0.75rem' }}
      >
        <Tabs items={TABS} current={HREF_FOR[current]} ariaLabel="Settings" />

        <div className="wa-row" style={{ gap: '0.5rem' }}>
          {context.memberships.length > 1 ? (
            <form action={selectOrg} className="wa-row" style={{ gap: '0.375rem' }}>
              <Select
                compact
                name="orgId"
                aria-label="Organisation"
                defaultValue={context.active?.orgId ?? ''}
                style={{ width: 'auto' }}
              >
                {context.memberships.map((membership) => (
                  <option key={membership.orgId} value={membership.orgId}>
                    {membership.name}
                  </option>
                ))}
              </Select>
              <Button type="submit" size="sm">
                Switch
              </Button>
            </form>
          ) : (
            <Badge data-testid="org-name">{context.active?.name ?? 'no organisation'}</Badge>
          )}
          {/*
            The exact string the role matrix asserts on. It is also the honest
            phrasing: a role is a fact about this session, not a label on a
            person, and every control on the screens below is decided by it.
          */}
          <Badge tone={role === null ? 'warn' : 'info'} dot data-testid="org-role">
            {context.active ? `role: ${context.active.role}` : 'no role'}
          </Badge>
        </div>
      </div>
      {children}
    </>
  );
}
