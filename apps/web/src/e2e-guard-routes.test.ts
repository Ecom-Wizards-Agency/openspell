import { describe, expect, it } from 'vitest';
import { GUARDED_ROUTES } from './e2e-guard-routes.js';

const EXPECTED_PATHS = [
  '/dashboard',
  '/grid',
  '/crosscheck',
  '/optimizer',
  '/optimizer/groups',
  '/strategy',
  '/query-intelligence',
  '/creative',
  '/dayparting',
  '/experiments',
  '/connect-claude',
  '/time-machine',
  '/recommendations',
  '/campaigns',
  '/ngrams',
  '/tags',
  '/feedback/new',
  '/bugs',
  '/roadmap',
  '/settings/connections',
  '/settings/integrations',
  '/settings/profiles',
  '/settings/members',
  '/settings/account',
  '/sync-status',
] as const;

describe('authenticated guard route contract', () => {
  it('owns the exact 25 unique guarded paths', () => {
    const paths = GUARDED_ROUTES.map(({ path }) => path);

    expect(paths).toEqual(EXPECTED_PATHS);
    expect(new Set(paths).size).toBe(25);
  });

  it('owns the exact seven requested routes that require a canonical profile', () => {
    expect(
      GUARDED_ROUTES.filter(
        ({ signedIn }) => signedIn.kind === 'requested' && signedIn.canonicalProfile === true,
      ).map(({ path }) => path),
    ).toEqual([
      '/dashboard',
      '/grid',
      '/optimizer',
      '/optimizer/groups',
      '/creative',
      '/recommendations',
      '/campaigns',
    ]);
  });

  it('owns the one complete signed-in redirect', () => {
    expect(
      GUARDED_ROUTES.filter(({ signedIn }) => signedIn.kind === 'redirect'),
    ).toEqual([
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
    ]);
  });

  it('owns the exact seven requested-route headings', () => {
    expect(
      GUARDED_ROUTES.flatMap(({ path, signedIn }) => (
        signedIn.kind === 'requested' && signedIn.heading !== undefined
          ? [[path, signedIn.heading]]
          : []
      )),
    ).toEqual([
      ['/dashboard', 'Dashboard'],
      ['/crosscheck', 'Crosscheck'],
      ['/optimizer', 'Campaign Optimizer'],
      ['/query-intelligence', 'Query Intelligence'],
      ['/creative', 'Creative Performance'],
      ['/dayparting', 'Dayparting'],
      ['/connect-claude', 'Connect AI (MCP)'],
    ]);
  });

  it('keeps every signed-in expectation attached to one guarded route', () => {
    expect(GUARDED_ROUTES).toHaveLength(25);
    expect(GUARDED_ROUTES.every(({ signedIn }) => signedIn.kind === 'requested'
      || signedIn.kind === 'redirect')).toBe(true);
  });
});
