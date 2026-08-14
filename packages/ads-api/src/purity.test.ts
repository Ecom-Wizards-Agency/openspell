/**
 * The boundary gate.
 *
 * `ads-api` is a client, not a service: it may import the contract package and
 * Node's own decompression, and nothing else of ours. It must never reach for
 * the database (that would put Amazon calls behind a transaction), the doctrine
 * engine (that would make recommendations depend on a network call), or an app.
 *
 * ESLint enforces the direction too. This test exists because a lint rule can
 * be silenced with a comment and a failing test cannot.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

const FORBIDDEN_PACKAGES = [
  '@wizard-ads/db',
  '@wizard-ads/core',
  '@wizard-ads/strategy',
  '@wizard-ads/ui',
  '@wizard-ads/campaigns',
  '@wizard-ads/worker',
  '@wizard-ads/web',
  '@wizard-ads/mcp',
];

/**
 * The filesystem and process are the worker's business. `node:zlib` is not on
 * the list on purpose: report payloads arrive gzipped, and decompressing bytes
 * already in hand is arithmetic, not I/O.
 */
const FORBIDDEN_MODULES = [
  'node:fs',
  'node:fs/promises',
  'fs',
  'node:child_process',
  'child_process',
  'node:net',
  'pg',
  'postgres',
  'drizzle-orm',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Fixtures are test-only scaffolding, not part of the client.
      if (entry.name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

describe('packages/ads-api stays inside its boundary', () => {
  const files = sourceFiles(SRC);

  it('has sources to check at all', () => {
    // A scan that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(10);
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
      // A dynamic import or a require would walk straight past the scan above.
      expect(text).not.toMatch(/\brequire\s*\(/);
      expect(text).not.toMatch(/[^.\w]import\s*\(/);
    });
  }

  it('depends on the contract package and nothing else', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@wizard-ads/shared']);
  });

  it('reads no credential from the environment: they arrive as arguments', () => {
    for (const file of sourceFiles(SRC)) {
      expect(readFileSync(file, 'utf8'), file.slice(SRC.length)).not.toMatch(/process\.env/);
    }
  });
});
