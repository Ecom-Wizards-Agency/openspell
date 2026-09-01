/** Pure command-line parsing for the web E2E runner. */
export const E2E_SUITES = [
  'tags-goto',
  'grid-performance',
  'profile-context',
  'auth',
  'auth-members',
  'auth-oauth',
  'auth-roles',
  'route-acceptance',
] as const;
export type E2ESuite = (typeof E2E_SUITES)[number];

export interface E2EInvocation {
  suites: E2ESuite[];
  playwrightArgs: string[];
}

/**
 * pnpm may preserve the conventional `--` used before forwarded script
 * arguments. Playwright treats that literal as its own option terminator, so a
 * filename after it no longer filters the suite. Consume one delimiter at the
 * runner boundary, both before and after an explicit suite name.
 */
export function parseE2EArgs(argv: readonly string[]): E2EInvocation {
  const normalized = argv[0] === '--' ? argv.slice(1) : [...argv];
  const [first, ...rest] = normalized;

  if (first === undefined) {
    return { suites: [...E2E_SUITES], playwrightArgs: [] };
  }
  if (first === 'all') {
    return {
      suites: [...E2E_SUITES],
      playwrightArgs: rest[0] === '--' ? rest.slice(1) : rest,
    };
  }
  if (first.startsWith('-')) {
    return {
      suites: [...E2E_SUITES],
      playwrightArgs: normalized,
    };
  }
  if (!(E2E_SUITES as readonly string[]).includes(first)) {
    throw new Error(`Unknown suite '${first}'. Expected one of: ${E2E_SUITES.join(', ')}, all.`);
  }

  return {
    suites: [first as E2ESuite],
    playwrightArgs: rest[0] === '--' ? rest.slice(1) : rest,
  };
}
