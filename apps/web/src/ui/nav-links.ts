/**
 * The navigation, as data.
 *
 * Its own module so the pure list can be imported by a server component, a
 * client component and a unit test without any of them dragging in the others.
 *
 * Grouping follows the recon's corrected map of the incumbent
 * (`tools/recon/01-navigation-map.md`): collapsible groups whose order is the
 * order an operator walks the product — look at the numbers, work the set,
 * review what the engine proposes, check it against the source, hand the model
 * a key, then the product's own feedback loop and finally the plumbing. Their
 * nav taught two lessons and both are applied here: name one surface one thing,
 * and give every surface a home in the nav.
 *
 * WP-24 aligns the labels to AdLabs' own nouns (Campaign Optimizer, Data Grid),
 * adds the `AI` group the recon found the incumbent shipping, and carries an
 * icon id per link for the rail — the same icon renders whether the sidebar is
 * expanded or collapsed to an icon strip.
 */
export interface NavLink {
  href: string;
  label: string;
  /** Icon id, resolved to an SVG in the sidebar. */
  icon: string;
  /** A short tag rendered beside the label, e.g. "Beta". */
  tag?: string;
}

export interface NavGroup {
  id: string;
  label: string;
  /** Icon id shown for the group when the rail is collapsed to icons. */
  icon: string;
  links: readonly NavLink[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'insights',
    label: 'Insights',
    icon: 'gauge',
    links: [{ href: '/dashboard', label: 'Dashboard', icon: 'gauge' }],
  },
  {
    id: 'optimize',
    label: 'Optimize',
    icon: 'sliders',
    links: [
      { href: '/optimizer', label: 'Campaign Optimizer', icon: 'sliders' },
      { href: '/optimizer/groups', label: 'Optimization Groups', icon: 'layers' },
      { href: '/recommendations', label: 'Recommendations', icon: 'check' },
      { href: '/campaigns', label: 'Campaign Builder', icon: 'layers' },
    ],
  },
  {
    id: 'analyze',
    label: 'Analyze',
    icon: 'grid',
    links: [
      { href: '/grid', label: 'Data Grid', icon: 'grid' },
      { href: '/ngrams', label: 'N-gram Explorer', icon: 'search' },
      { href: '/tags', label: 'Tags', icon: 'tag' },
      { href: '/experiments', label: 'Experiments', icon: 'flask' },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    icon: 'shield',
    links: [
      { href: '/crosscheck', label: 'Crosscheck', icon: 'shield' },
      { href: '/time-machine', label: 'Time Machine', icon: 'history' },
      { href: '/sync-status', label: 'Sync status', icon: 'clock' },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    icon: 'spark',
    links: [{ href: '/connect-claude', label: 'Connect AI (MCP)', icon: 'spark', tag: 'Beta' }],
  },
  {
    id: 'product',
    label: 'Product',
    icon: 'chat',
    links: [
      { href: '/bugs', label: 'Bugs', icon: 'bug' },
      { href: '/roadmap', label: 'Roadmap', icon: 'map' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: 'cog',
    links: [{ href: '/settings', label: 'Settings', icon: 'cog' }],
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
