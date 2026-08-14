/**
 * The purity gate.
 *
 * `campaigns` may import the contract package and `strategy`, and nothing else
 * of ours. It may not read the world: no filesystem, no network, no clock.
 *
 * The clock is the one worth spelling out, because it is not obvious. Every
 * entry point takes `today` as an argument. If any of them called
 * `Date.now()`, the plan a config produces would depend on the day it was
 * produced, the parity suite could not replay a golden against it, and the
 * whole check that this port still agrees with the Python reference would stop
 * being possible.
 *
 * ESLint enforces the package rule too. This test exists because a lint rule
 * can be disabled inline and a failing test is harder to argue with.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PACKAGES = [
  '@wizard-ads/db',
  '@wizard-ads/ads-api',
  '@wizard-ads/ui',
  '@wizard-ads/core',
  '@wizard-ads/worker',
  '@wizard-ads/web',
  '@wizard-ads/mcp',
];

/** Anything that reads the world instead of its arguments. */
const FORBIDDEN_MODULES = [
  'node:fs', 'node:http', 'node:https', 'node:net', 'node:child_process', 'node:zlib',
  'fs', 'http', 'path', 'node:path',
];

/** Anything that reads the clock. `today` is always an argument. */
const CLOCK_PATTERNS = [/\bDate\.now\s*\(/, /\bnew\s+Date\s*\(\s*\)/, /\bperformance\.now\s*\(/];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

describe('packages/campaigns is pure', () => {
  const files = sourceFiles(SRC);

  it('has sources to check at all', () => {
    // A scan that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(8);
  });

  for (const file of files) {
    const relative = file.slice(SRC.length);
    it(`${relative} imports nothing forbidden`, () => {
      const text = readFileSync(file, 'utf8');
      const specifiers: string[] = [];
      for (const match of text.matchAll(IMPORT_RE)) specifiers.push(match[1] as string);
      for (const specifier of specifiers) {
        expect(FORBIDDEN_PACKAGES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(FORBIDDEN_MODULES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(specifier.startsWith('../../'), `${relative} reaches outside the package`).toBe(false);
      }
      // Dynamic imports and require would bypass the scan above.
      expect(text).not.toMatch(/\brequire\s*\(/);
      expect(text).not.toMatch(/\bimport\s*\(/);
    });

    it(`${relative} reads no clock`, () => {
      const text = readFileSync(file, 'utf8');
      for (const pattern of CLOCK_PATTERNS) {
        expect(pattern.test(text), `${relative} matches ${pattern}`).toBe(false);
      }
    });
  }

  it('only depends on the contract package', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // `strategy` is permitted by the brief but not yet needed: the tenant
    // document arrives as a `TenantStrategy` from `shared`, and resolving one
    // is the caller's job. Adding the dependency before there is a call for it
    // would be a boundary nobody is using.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@wizard-ads/shared']);
  });

  it('exports no BMM campaign type from the generation matrix', async () => {
    const { CAMPAIGN_TYPES, DROPPED_CAMPAIGN_TYPES } = await import('./constants.js');
    expect(CAMPAIGN_TYPES).not.toContain('BMM');
    expect(DROPPED_CAMPAIGN_TYPES.BMM).toBeDefined();
  });
});
