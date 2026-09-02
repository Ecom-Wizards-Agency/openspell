/** Signed-in behavior expected from one guarded application route. */
export type SignedInExpectation =
  | {
      readonly kind: 'requested';
      readonly canonicalProfile?: true;
      readonly heading?: string;
    }
  | {
      readonly kind: 'redirect';
      readonly pathname: string;
      readonly hash: string;
      readonly canonicalProfile: true;
      readonly artifact: string;
      readonly heading: string;
    };

export interface GuardedRoute {
  readonly path: string;
  readonly signedIn: SignedInExpectation;
}

/**
 * Every screen the navigation offers and its complete signed-in destination.
 *
 * Anonymous and signed-in browser sweeps consume this same immutable contract.
 * Keep conditional route expectations beside their route so the two process
 * partitions cannot drift through parallel path and expectation lists.
 */
export const GUARDED_ROUTES: readonly GuardedRoute[] = [
  {
    path: '/dashboard',
    signedIn: { kind: 'requested', canonicalProfile: true, heading: 'Dashboard' },
  },
  { path: '/grid', signedIn: { kind: 'requested', canonicalProfile: true } },
  { path: '/crosscheck', signedIn: { kind: 'requested', heading: 'Crosscheck' } },
  {
    path: '/optimizer',
    signedIn: { kind: 'requested', canonicalProfile: true, heading: 'Campaign Optimizer' },
  },
  { path: '/optimizer/groups', signedIn: { kind: 'requested', canonicalProfile: true } },
  {
    path: '/strategy',
    signedIn: {
      kind: 'redirect',
      pathname: '/dashboard',
      hash: '#operating-status',
      canonicalProfile: true,
      artifact: '#operating-status',
      heading: 'Top campaigns by spend',
    },
  },
  {
    path: '/query-intelligence',
    signedIn: { kind: 'requested', heading: 'Query Intelligence' },
  },
  {
    path: '/creative',
    signedIn: { kind: 'requested', canonicalProfile: true, heading: 'Creative Performance' },
  },
  { path: '/dayparting', signedIn: { kind: 'requested', heading: 'Dayparting' } },
  { path: '/experiments', signedIn: { kind: 'requested' } },
  { path: '/connect-claude', signedIn: { kind: 'requested', heading: 'Connect AI (MCP)' } },
  { path: '/time-machine', signedIn: { kind: 'requested' } },
  { path: '/recommendations', signedIn: { kind: 'requested', canonicalProfile: true } },
  { path: '/campaigns', signedIn: { kind: 'requested', canonicalProfile: true } },
  { path: '/ngrams', signedIn: { kind: 'requested' } },
  { path: '/tags', signedIn: { kind: 'requested' } },
  { path: '/feedback/new', signedIn: { kind: 'requested' } },
  { path: '/bugs', signedIn: { kind: 'requested' } },
  { path: '/roadmap', signedIn: { kind: 'requested' } },
  { path: '/settings/connections', signedIn: { kind: 'requested' } },
  { path: '/settings/integrations', signedIn: { kind: 'requested' } },
  { path: '/settings/profiles', signedIn: { kind: 'requested' } },
  { path: '/settings/members', signedIn: { kind: 'requested' } },
  { path: '/settings/account', signedIn: { kind: 'requested' } },
  { path: '/sync-status', signedIn: { kind: 'requested' } },
] as const;
