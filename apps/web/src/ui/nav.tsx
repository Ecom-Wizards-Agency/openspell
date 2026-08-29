/**
 * The authenticated application frame: a left sidebar, a top bar, and the only
 * place the app says which operator is signed in. Anonymous screens use a quiet
 * public header rather than advertising an operator navigation they cannot open.
 *
 * Before this existed the product had no visible way in — `/login` was reachable
 * only by typing it — and then, briefly, a flat bar of ten equal links. Neither
 * is a shape a tool with ten screens can wear. This is the incumbent's pattern
 * (`tools/recon/01-navigation-map.md`, `UI-verified`): grouped, collapsible
 * navigation down the left, tenancy and identity along the top, content in the
 * remaining space.
 *
 * Two exports, deliberately split, unchanged from the version this replaces:
 *
 *  - `NavBar` is pure. It takes the identity and the roster it renders and
 *    touches nothing ambient, so a unit test can render both states without a
 *    request.
 *  - `AppNav` is the server component the root layout mounts. It receives the
 *    resolved session, reads the roster and hands both to `NavBar`.
 *
 * `AppNav` imports its data lazily for the reason `src/server/request-context.ts`
 * documents: `next/headers` only works inside a request, and a top-level import
 * would drag it into the module graph of every Vitest suite that renders this
 * file.
 */
import type { ReactNode } from 'react';
import type { SessionUser } from '../auth/session';
import { NAV_GROUPS, NAV_LINKS } from './nav-links';
import type { NavGroup, NavLink } from './nav-links';
import { ProfileAwareBrand } from './profile-aware-brand';
import { SidebarNav } from './sidebar';
import { IdentityMenu, ProfileSwitcher, ThemeToggle } from './topbar-controls';
import type { NavProfile } from './topbar-controls';

export { NAV_GROUPS, NAV_LINKS };
export type { NavGroup, NavLink, NavProfile };

export interface NavUser {
  id: string;
  email: string | null;
}

export interface NavBarProps {
  user: NavUser | null;
  /** The org's advertising profiles, for the top bar's switcher. */
  profiles?: readonly NavProfile[];
  /** The active organisation's name, when one could be resolved. */
  orgName?: string | null;
}

export function NavBar({ user, profiles = [], orgName = null }: NavBarProps): ReactNode {
  if (user === null) {
    return (
      <div data-testid="app-nav" data-auth-state="anonymous">
        <a className="wa-skip" href="#wa-main">
          Skip to content
        </a>

        <header className="wa-public-topbar">
          <ProfileAwareBrand />
          <span className="wa-topbar-spacer" />
          <ThemeToggle />
          <a href="/login" className="wa-btn wa-btn--sm" data-testid="nav-signin">
            Sign in
          </a>
        </header>
      </div>
    );
  }

  return (
    <div data-testid="app-nav" data-auth-state="authenticated">
      <a className="wa-skip" href="#wa-main">
        Skip to content
      </a>

      <aside className="wa-sidebar">
        <ProfileAwareBrand />

        <SidebarNav />

        <p className="wa-sidebar-foot">
          Amazon Advertising, in house. Every number on every screen is only as
          fresh as the last sync.
        </p>
      </aside>

      <header className="wa-topbar">
        {orgName === null ? null : (
          <span className="wa-topbar-org" title={orgName}>
            {orgName}
          </span>
        )}

        <span className="wa-topbar-spacer" />

        <ProfileSwitcher profiles={profiles} />
        <ThemeToggle />

        <IdentityMenu email={user.email} />
      </header>
    </div>
  );
}

/**
 * The root layout's frame: the same chrome, with the real session behind it.
 *
 * The root layout resolves the session once and shares it with the navigation
 * and authenticated-only frame controls. The roster read is best-effort on
 * purpose. The switcher is a convenience in the chrome, and chrome must never
 * be the reason a screen fails to render — an unreachable database already has
 * a page that says so, and it is not this one's job to say it a second time in
 * a stack trace.
 */
export async function AppNav({ user }: { user: SessionUser | null }): Promise<ReactNode> {
  if (user === null) return <NavBar user={null} />;

  const { navContext } = await import('./nav-context');
  const context = await navContext(user);
  return <NavBar user={user} profiles={context.profiles} orgName={context.orgName} />;
}
