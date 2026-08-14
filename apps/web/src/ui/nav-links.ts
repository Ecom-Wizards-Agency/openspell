/**
 * The navigation, as data.
 *
 * Its own module so the pure list can be imported by a server component, a
 * client component and a unit test without any of them dragging in the others.
 *
 * Grouping follows the recon's corrected map of the incumbent
 * (`tools/recon/01-navigation-map.md`): six collapsible groups whose order is
 * the order an operator walks the product — look at the numbers, work the set,
 * review what the engine proposes, check it against the source, then the
 * product's own feedback loop and finally the plumbing. Their nav taught two
 * lessons and both are applied here: name one surface one thing, and give every
 * surface a home in the nav.
 */
export interface NavLink {
  href: string;
  label: string;
}

export interface NavGroup {
  id: string;
  label: string;
  links: readonly NavLink[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'insights',
    label: 'Insights',
    links: [{ href: '/dashboard', label: 'Dashboard' }],
  },
  {
    id: 'optimize',
    label: 'Optimize',
    links: [{ href: '/recommendations', label: 'Recommendations' }],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    links: [
      { href: '/grid', label: 'Grid' },
      { href: '/ngrams', label: 'N-gram' },
      { href: '/tags', label: 'Tags' },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    links: [
      { href: '/crosscheck', label: 'Crosscheck' },
      { href: '/sync-status', label: 'Sync status' },
    ],
  },
  {
    id: 'product',
    label: 'Product',
    links: [
      { href: '/feedback', label: 'Feedback' },
      { href: '/roadmap', label: 'Roadmap' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    links: [{ href: '/settings', label: 'Settings' }],
  },
] as const;

/**
 * Every screen, flat.
 *
 * Derived rather than maintained alongside the groups, so a route can never be
 * in one and missing from the other. `nav.test.ts` asserts the frame renders
 * all of these in both session states.
 */
export const NAV_LINKS: readonly NavLink[] = NAV_GROUPS.flatMap((group) => group.links);
