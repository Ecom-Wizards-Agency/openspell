import { describe, expect, it } from 'vitest';
import {
  E2E_SUITE_DEFINITIONS,
  E2E_SUITES,
  getE2ESuiteDefinition,
  runE2ESuiteMatrix,
} from './e2e-suite-registry.js';

const EXPECTED_REGISTRY = [
  ['tags-goto', 'production-bridge', 'playwright.tags-goto.config.ts', 'tags-goto', ['campaigns.spec.ts', 'experiments.spec.ts', 'feedback.spec.ts', 'recommendations.spec.ts', 'tags-goto.spec.ts', 'time-machine.spec.ts'], 32],
  ['grid-performance', 'authenticated-dev', 'playwright.grid-performance.config.ts', 'grid-performance', ['grid-performance.spec.ts'], 1],
  ['optimization-groups', 'authenticated-dev', 'playwright.optimization-groups.config.ts', 'optimization-groups', ['optimization-groups.spec.ts'], 2],
  ['profile-context', 'authenticated-dev', 'playwright.profile-context.config.ts', 'profile-context', ['profile-context.spec.ts', 'sidebar-layout.spec.ts'], 8],
  ['auth-guards-anonymous', 'authenticated-dev', 'playwright.auth-guards-anonymous.config.ts', 'auth-guards-anonymous', ['guards-anonymous.spec.ts'], 2],
  ['auth-guards-signed-in', 'authenticated-dev', 'playwright.auth-guards-signed-in.config.ts', 'auth-guards-signed-in', ['guards-signed-in.spec.ts'], 3],
  ['auth', 'authenticated-dev', 'playwright.auth.config.ts', 'auth', ['dashboard.spec.ts', 'grid.spec.ts'], 4],
  ['auth-members', 'authenticated-dev', 'playwright.auth-members.config.ts', 'auth-members', ['members.spec.ts'], 5],
  ['auth-oauth', 'authenticated-dev', 'playwright.auth-oauth.config.ts', 'auth-oauth', ['oauth.spec.ts'], 7],
  ['auth-roles', 'authenticated-dev', 'playwright.auth-roles.config.ts', 'auth-roles', ['roles.spec.ts'], 8],
  ['route-acceptance', 'authenticated-dev', 'playwright.route-acceptance.config.ts', 'route-acceptance', ['route-acceptance.dashboard.spec.ts'], 3],
] as const;

describe('web E2E suite registry', () => {
  it('owns the exact ordered suite-to-process mapping', () => {
    expect(
      E2E_SUITE_DEFINITIONS.map((definition) => [
        definition.name,
        definition.kind,
        definition.config,
        definition.project,
        [...definition.expectedSpecFiles],
        definition.expectedTests,
      ]),
    ).toEqual(EXPECTED_REGISTRY);
    expect(E2E_SUITES).toEqual(EXPECTED_REGISTRY.map(([name]) => name));
  });

  it('keeps names, configs, projects and spec ownership unique', () => {
    const values = {
      names: E2E_SUITE_DEFINITIONS.map(({ name }) => name),
      configs: E2E_SUITE_DEFINITIONS.map(({ config }) => config),
      projects: E2E_SUITE_DEFINITIONS.map(({ project }) => project),
      specs: E2E_SUITE_DEFINITIONS.flatMap(({ expectedSpecFiles }) => expectedSpecFiles),
    };
    for (const [label, candidates] of Object.entries(values)) {
      expect(new Set(candidates).size, label).toBe(candidates.length);
    }
  });

  it('conserves all 75 logical test cases and resolves every dispatch entry', () => {
    expect(E2E_SUITE_DEFINITIONS.reduce((total, suite) => total + suite.expectedTests, 0)).toBe(75);
    expect(E2E_SUITES.map((suite) => getE2ESuiteDefinition(suite))).toEqual(E2E_SUITE_DEFINITIONS);
  });

  it('runs later suites after a thrown setup failure and preserves its diagnostic', async () => {
    const selected = E2E_SUITE_DEFINITIONS.slice(0, 3);
    const thrown = new Error('production bridge setup failed');
    const calls: string[] = [];
    const diagnostics: Array<[string, unknown]> = [];

    const code = await runE2ESuiteMatrix(
      selected,
      async (definition) => {
        calls.push(definition.name);
        if (definition === selected[0]) throw thrown;
        return definition === selected[1] ? 7 : 0;
      },
      (definition, error) => diagnostics.push([definition.name, error]),
    );

    expect(calls).toEqual(selected.map(({ name }) => name));
    expect(diagnostics).toEqual([['tags-goto', thrown]]);
    expect(code).toBe(7);
  });
});
