/**
 * The header every WP-04 screen shares: who you are, which org, where to go.
 *
 * A server component. The org switcher is a plain form posting to a server
 * action rather than a client-side select, because a page that already renders
 * per-org on the server does not need hydration to change one cookie.
 */
import type { ReactNode } from 'react';
import type { OrgContext } from '../data/orgs';
import { selectOrg } from './actions';
import { colors, muted } from './tokens';

export function Shell({
  context,
  current,
  children,
}: {
  context: OrgContext;
  current: 'connections' | 'profiles' | 'sync' | 'feedback' | 'roadmap';
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <header
        style={{
          alignItems: 'center',
          borderBottom: `1px solid ${colors.border}`,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          justifyContent: 'space-between',
          marginBottom: '1.5rem',
          paddingBottom: '0.75rem',
        }}
      >
        <nav style={{ display: 'flex', gap: '1rem' }}>
          <NavLink href="/settings/connections" active={current === 'connections'}>
            Connections
          </NavLink>
          <NavLink href="/settings/profiles" active={current === 'profiles'}>
            Profiles
          </NavLink>
          <NavLink href="/sync-status" active={current === 'sync'}>
            Sync status
          </NavLink>
          <NavLink href="/feedback" active={current === 'feedback'}>
            Feedback
          </NavLink>
          <NavLink href="/roadmap" active={current === 'roadmap'}>
            Roadmap
          </NavLink>
        </nav>

        <div style={{ alignItems: 'center', display: 'flex', gap: '0.75rem' }}>
          {context.memberships.length > 1 ? (
            <form action={selectOrg} style={{ display: 'flex', gap: '0.375rem' }}>
              <select
                name="orgId"
                aria-label="Organisation"
                defaultValue={context.active?.orgId ?? ''}
                style={{ fontSize: '0.8125rem', padding: '0.25rem' }}
              >
                {context.memberships.map((membership) => (
                  <option key={membership.orgId} value={membership.orgId}>
                    {membership.name}
                  </option>
                ))}
              </select>
              <button type="submit" style={{ fontSize: '0.8125rem' }}>
                Switch
              </button>
            </form>
          ) : (
            <span style={muted} data-testid="org-name">
              {context.active?.name ?? 'no organisation'}
            </span>
          )}
          <span style={muted} data-testid="org-role">
            {context.active ? `role: ${context.active.role}` : 'no role'}
          </span>
          <form action="/auth/signout" method="post">
            <button type="submit" style={{ fontSize: '0.8125rem' }}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <a
      href={href}
      style={{
        color: active ? colors.text : colors.muted,
        fontSize: '0.875rem',
        fontWeight: active ? 600 : 400,
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  );
}
