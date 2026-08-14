/**
 * The application frame's one navigation bar, and the only place the app says
 * whether anybody is signed in.
 *
 * Before this existed the product had no visible way in: `/login` was reachable
 * only by typing it, and a signed-in operator had no way out except the settings
 * screens' own header. A tool whose sign-in is a URL you have to know is not
 * shipped, however complete the routes behind it are.
 *
 * Two exports, deliberately split:
 *
 *  - `NavBar` is pure. It takes the identity it renders and touches nothing
 *    ambient, so a unit test can render both states without a request.
 *  - `AppNav` is the server component the root layout mounts. It resolves the
 *    session and hands it to `NavBar`.
 *
 * `AppNav` imports `currentUser` lazily for the reason `src/server/request-
 * context.ts` documents: `next/headers` only works inside a request, and a
 * top-level import would drag it into the module graph of every Vitest suite
 * that renders this file.
 *
 * Inline styles and `src/ui/tokens.ts`, matching the WP-04 screens. WP-06 owns
 * look and feel; when it lands, replacing this is a deletion rather than an
 * untangling.
 */
import type { CSSProperties, ReactNode } from 'react';
import { colors } from './tokens';

export interface NavUser {
  id: string;
  email: string | null;
}

/**
 * Every screen the product has, in the order an operator walks them: look at
 * the numbers, work the grid, review what the engine proposes, then the
 * supporting surfaces and finally the plumbing.
 */
export const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/grid', label: 'Grid' },
  { href: '/recommendations', label: 'Recommendations' },
  { href: '/ngrams', label: 'N-gram' },
  { href: '/tags', label: 'Tags' },
  { href: '/feedback', label: 'Feedback' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/crosscheck', label: 'Crosscheck' },
  { href: '/settings', label: 'Settings' },
  { href: '/sync-status', label: 'Sync status' },
] as const;

export function NavBar({ user }: { user: NavUser | null }): ReactNode {
  return (
    <header style={bar} data-testid="app-nav">
      <a href="/" style={brand}>
        wizard-ads
      </a>

      <nav aria-label="Primary" style={links}>
        {NAV_LINKS.map((link) => (
          <a key={link.href} href={link.href} style={item}>
            {link.label}
          </a>
        ))}
      </nav>

      {user === null ? (
        <a href="/login" style={signIn} data-testid="nav-signin">
          Sign in
        </a>
      ) : (
        <span style={identity} data-testid="nav-identity">
          <span style={{ color: colors.muted }}>
            signed in as {user.email ?? 'your account'}
          </span>
          <span aria-hidden="true" style={{ color: colors.border }}>
            ·
          </span>
          <form action="/auth/signout" method="post" style={{ display: 'inline' }}>
            <button type="submit" style={signOut} data-testid="nav-signout">
              sign out
            </button>
          </form>
        </span>
      )}
    </header>
  );
}

/** The root layout's nav: the same bar, with the real session behind it. */
export async function AppNav(): Promise<ReactNode> {
  const { currentUser } = await import('../auth/session');
  const user = await currentUser();
  return <NavBar user={user} />;
}

const bar: CSSProperties = {
  alignItems: 'center',
  borderBottom: `1px solid ${colors.border}`,
  display: 'flex',
  flexWrap: 'wrap',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: '0.8125rem',
  gap: '1rem',
  justifyContent: 'space-between',
  padding: '0.625rem 1.5rem',
};

const brand: CSSProperties = {
  color: colors.text,
  fontWeight: 600,
  textDecoration: 'none',
};

const links: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.875rem',
};

const item: CSSProperties = {
  color: colors.muted,
  textDecoration: 'none',
};

const identity: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: '0.5rem',
};

const signIn: CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.25rem',
  color: colors.text,
  padding: '0.25rem 0.625rem',
  textDecoration: 'none',
};

const signOut: CSSProperties = {
  background: 'none',
  border: 'none',
  color: colors.muted,
  cursor: 'pointer',
  font: 'inherit',
  padding: 0,
  textDecoration: 'underline',
};
