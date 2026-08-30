'use client';

/**
 * The sidebar's navigation: one direct home link, three task groups, and quiet
 * utility links above the icon-rail collapse toggle.
 *
 * The shape is the recon's (`tools/recon/01-navigation-map.md`): the incumbent's
 * nav is a projection of the entity hierarchy into named groups, which is why an
 * operator can guess where anything lives. Ours is the same idea over our own
 * routes — and it fixes the finding that indicted theirs, that a whole working
 * surface sat at an unlinked route. **Every screen this product has is in this
 * list.** `nav.test.ts` counts them against `NAV_LINKS` so it stays true.
 *
 * `<details>` rather than a JavaScript disclosure: it collapses, it is keyboard
 * operable and it is announced correctly with no code from us, and — the reason
 * that matters here — the links inside are present in the server-rendered markup
 * whether or not the group is open, so nothing about navigation waits on
 * hydration. When the rail is collapsed to icons the labels stay in the DOM and
 * are hidden with CSS, so the same server markup carries both states and the
 * unit test sees every label.
 *
 * A client component for three reasons: marking the current page, remembering
 * the collapse/open state in `localStorage`, and carrying the active
 * `?profile=` across App Router navigation. Next's pathname/search hooks keep
 * the chrome current through push, back and forward transitions.
 */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { beginRouteNavigation } from '../performance/navigation';
import { shouldPrefetchRoute } from '../performance/routes';
import { NAV_GROUPS } from './nav-links';
import type { NavLink } from './nav-links';
import { NavIcon } from './nav-icons';

const CLOSED_KEY = 'openspell.nav.closed.v2';
const COLLAPSED_KEY = 'wizard-ads.nav.collapsed';
const WORKFLOW_GROUP_IDS = new Set(['optimize', 'analyze', 'verify']);
const PRIMARY_LINKS = NAV_GROUPS.filter((group) => group.id === 'insights').flatMap(
  (group) => group.links,
);
const WORKFLOW_GROUPS = NAV_GROUPS.filter((group) => WORKFLOW_GROUP_IDS.has(group.id));
const UTILITY_LINKS = NAV_GROUPS.filter(
  (group) => group.id === 'ai' || group.id === 'product' || group.id === 'admin',
).flatMap((group) => group.links);
const DEFAULT_CLOSED = WORKFLOW_GROUPS.map((group) => group.id);

export function SidebarNav(): ReactNode {
  const pathname = usePathname();
  const profile = useSearchParams().get('profile');
  const [closed, setClosed] = useState<readonly string[]>(DEFAULT_CLOSED);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CLOSED_KEY);
      if (stored !== null) setClosed(JSON.parse(stored) as string[]);
      applyCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === 'true', setCollapsed);
    } catch {
      // A corrupt or unavailable store is not a reason to lose the nav.
    }
  }, []);

  const remember = (id: string, open: boolean): void => {
    setClosed((current) => {
      const next = open ? current.filter((entry) => entry !== id) : [...new Set([...current, id])];
      try {
        window.localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        // Persistence is a courtesy; the session still works without it.
      }
      return next;
    });
  };

  const toggleCollapsed = (): void => {
    const next = !collapsed;
    applyCollapsed(next, setCollapsed);
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Same courtesy as above.
    }
  };

  return (
    <>
      <nav aria-label="Primary" className="wa-sidebar-main">
        <ul className="wa-navlist wa-navlist--direct">
          {PRIMARY_LINKS.map((link) => (
            <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} />
          ))}
        </ul>

        {WORKFLOW_GROUPS.map((group) => {
          const holdsCurrent =
            pathname !== null && group.links.some((link) => isCurrent(link.href, pathname));
          return (
            <details
              key={group.id}
              className="wa-navgroup"
              open={holdsCurrent || !closed.includes(group.id)}
              onToggle={(event) => remember(group.id, event.currentTarget.open)}
            >
              <summary title={group.label}>
                <svg aria-hidden="true" className="wa-navgroup-caret" viewBox="0 0 8 8">
                  <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                <span aria-hidden="true" className="wa-navgroup-icon">
                  <NavIcon icon={group.icon} />
                </span>
                <span className="wa-navgroup-label">{group.label}</span>
              </summary>
              <ul className="wa-navlist">
                {group.links.map((link) => (
                  <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} />
                ))}
              </ul>
            </details>
          );
        })}
      </nav>

      <footer className="wa-sidebar-utilities">
        <nav aria-label="Product and account">
          <ul className="wa-navlist">
            {UTILITY_LINKS.map((link) => (
              <NavLinkRow key={link.href} link={link} pathname={pathname} profile={profile} />
            ))}
          </ul>
        </nav>

        <button
          type="button"
          className="wa-nav-collapse"
          data-testid="nav-collapse"
          aria-pressed={collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          onClick={toggleCollapsed}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="wa-nav-collapse-icon">
            <path
              d="M10 3.5 5.5 8l4.5 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="wa-navlink-label">Collapse</span>
        </button>
      </footer>
    </>
  );
}

function NavLinkRow({
  link,
  pathname,
  profile,
}: {
  link: NavLink;
  pathname: string | null;
  profile: string | null;
}): ReactNode {
  const current = pathname !== null && isCurrent(link.href, pathname);
  return (
    <li>
      <Link
        href={withProfile(link.href, profile)}
        prefetch={shouldPrefetchRoute(link.href) ? null : false}
        onNavigate={() => beginRouteNavigation()}
        className="wa-navlink"
        title={link.label}
        {...(current ? { 'aria-current': 'page' as const } : {})}
      >
        <span aria-hidden="true" className="wa-navlink-icon">
          <NavIcon icon={link.icon} />
        </span>
        <span className="wa-navlink-label">{link.label}</span>
        {link.tag === undefined ? null : <span className="wa-navlink-tag">{link.tag}</span>}
      </Link>
    </li>
  );
}

/** Reflect the collapse state onto the root so CSS can resize the whole frame. */
function applyCollapsed(value: boolean, set: (value: boolean) => void): void {
  set(value);
  if (value) document.documentElement.setAttribute('data-nav-collapsed', 'true');
  else document.documentElement.removeAttribute('data-nav-collapsed');
}

/**
 * Carry the chosen advertising profile through the navigation.
 *
 * Tenancy in this product is a parameter on the route, not a path prefix (see
 * `topbar-controls.tsx`), so a bare `href` is an instruction to forget which
 * profile the operator is looking at. Every link therefore re-states it. The `href` the
 * active-link check compares is still the bare one: the profile decides what a
 * screen shows, never which screen you are on.
 *
 * The links have no query of their own, so appending is the whole job.
 */
function withProfile(href: string, profile: string | null): string {
  if (profile === null || profile === '') return href;
  return `${href}?profile=${encodeURIComponent(profile)}`;
}

/**
 * `/settings` is current while you are on `/settings/profiles`; `/grid` is not
 * current because you are on `/gridiron`. Prefix matching, on a segment
 * boundary.
 */
function isCurrent(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
