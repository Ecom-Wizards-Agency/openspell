import { describe, expect, it } from 'vitest';
import { parseE2EArgs } from './e2e-args.js';

describe('web E2E runner arguments', () => {
  it('forwards an exact spec after a pnpm delimiter', () => {
    expect(parseE2EArgs(['auth', '--', 'grid.spec.ts'])).toEqual({
      suites: ['auth'],
      playwrightArgs: ['grid.spec.ts'],
    });
  });

  it('accepts the delimiter before the suite name', () => {
    expect(parseE2EArgs(['--', 'auth', 'roles.spec.ts'])).toEqual({
      suites: ['auth'],
      playwrightArgs: ['roles.spec.ts'],
    });
  });

  it('preserves Playwright options while selecting every suite', () => {
    expect(parseE2EArgs(['--grep', 'readiness'])).toEqual({
      suites: [
        'tags-goto',
        'grid-performance',
        'profile-context',
        'auth',
        'auth-roles',
        'route-acceptance',
      ],
      playwrightArgs: ['--grep', 'readiness'],
    });
  });

  it('does not forward the all-suite selector to Playwright', () => {
    expect(parseE2EArgs(['all', '--', 'grid.spec.ts'])).toEqual({
      suites: [
        'tags-goto',
        'grid-performance',
        'profile-context',
        'auth',
        'auth-roles',
        'route-acceptance',
      ],
      playwrightArgs: ['grid.spec.ts'],
    });
  });

  it('rejects an unknown suite instead of silently running everything', () => {
    expect(() => parseE2EArgs(['unknown'])).toThrow(
      "Unknown suite 'unknown'. Expected one of: tags-goto, grid-performance, profile-context, auth, auth-roles, route-acceptance, all.",
    );
  });
});
