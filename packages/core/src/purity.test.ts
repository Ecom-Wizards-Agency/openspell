/**
 * The purity gate.
 *
 * `core` may import the contract package and nothing else of ours, and it may
 * not perform I/O. Both rules are load-bearing rather than stylistic: the
 * moment the doctrine engine can read a database or a file, it cannot be
 * replayed against a golden, and the parity suite that proves it still agrees
 * with the Python reference stops being possible.
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
  '@wizard-ads/strategy',
  '@wizard-ads/worker',
  '@wizard-ads/web',
  '@wizard-ads/mcp',
];

/** Anything that reads the world instead of its arguments. */
const FORBIDDEN_MODULES = ['node:fs', 'node:http', 'node:https', 'node:net', 'node:child_process', 'fs', 'http'];

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

describe('packages/core is pure', () => {
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
  }

  it('only depends on the contract package', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@wizard-ads/shared']);
  });
});
