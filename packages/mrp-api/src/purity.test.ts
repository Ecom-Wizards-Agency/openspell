import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const FORBIDDEN_PACKAGES = [
  '@wizard-ads/db',
  '@wizard-ads/core',
  '@wizard-ads/strategy',
  '@wizard-ads/ads-api',
  '@wizard-ads/ui',
  '@wizard-ads/campaigns',
  '@wizard-ads/worker',
  '@wizard-ads/web',
  '@wizard-ads/mcp',
];
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
  '@modelcontextprotocol/sdk',
];

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__') continue;
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

describe('packages/mrp-api stays inside its boundary', () => {
  const files = sourceFiles(SRC);

  it('has production sources to inspect', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    const relative = file.slice(SRC.length);
    it(`${relative} imports nothing forbidden`, () => {
      const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(IMPORT_RE)].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(FORBIDDEN_PACKAGES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(FORBIDDEN_MODULES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(specifier?.startsWith('../../'), `${relative} reaches outside the package`).toBe(false);
      }
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/[^.\w]import\s*\(/);
    });
  }

  it('depends on the contract package and nothing else', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@wizard-ads/shared']);
  });

  it('reads no credential or endpoint from process.env', () => {
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/process\.env/);
  });
});
