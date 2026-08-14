'use client';

/**
 * The sidebar's navigation: six collapsible groups, not a flat list.
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
 * hydration.
 *
 * A client component for exactly one reason: marking the current page. Next
 * gives a server component no pathname, and `usePathname` would tie this file to
 * a router context that the pure unit test does not have. Reading
 * `window.location` after mount costs one effect and keeps the component
 * renderable anywhere.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { NAV_GROUPS } from './nav-links';

const CLOSED_KEY = 'wizard-ads.nav.closed';

export function SidebarNav(): ReactNode {
  const [pathname, setPathname] = useState<string | null>(null);
  const [closed, setClosed] = useState<readonly string[]>([]);

  useEffect(() => {
    setPathname(window.location.pathname);
    try {
      const stored = window.localStorage.getItem(CLOSED_KEY);
      if (stored !== null) setClosed(JSON.parse(stored) as string[]);
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

  return (
    <nav aria-label="Primary" style={{ display: 'contents' }}>
      {NAV_GROUPS.map((group) => {
        const holdsCurrent =
          pathname !== null && group.links.some((link) => isCurrent(link.href, pathname));
        return (
          <details
            key={group.id}
            className="wa-navgroup"
            open={holdsCurrent || !closed.includes(group.id)}
            onToggle={(event) => remember(group.id, event.currentTarget.open)}
          >
            <summary>
              <svg aria-hidden="true" className="wa-navgroup-caret" viewBox="0 0 8 8">
                <path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {group.label}
            </summary>
            <ul className="wa-navlist">
              {group.links.map((link) => {
                const current = pathname !== null && isCurrent(link.href, pathname);
                return (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="wa-navlink"
                      {...(current ? { 'aria-current': 'page' as const } : {})}
                    >
                      <span aria-hidden="true" className="wa-navlink-dot" />
                      {link.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </nav>
  );
}

/**
 * `/settings` is current while you are on `/settings/profiles`; `/grid` is not
 * current because you are on `/gridiron`. Prefix matching, on a segment
 * boundary.
 */
function isCurrent(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
