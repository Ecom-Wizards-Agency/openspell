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
  'node:fs', 'node:fs/promises', 'fs', 'node:child_process', 'child_process',
  'node:net', 'pg', 'postgres', 'drizzle-orm',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__fixtures__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g;

describe('packages/keepa-api stays pure', () => {
  const files = sourceFiles(SRC);

  it('checks a real source surface', () => expect(files.length).toBeGreaterThan(5));

  for (const file of files) {
    const relative = file.slice(SRC.length);
    it(`${relative} imports nothing forbidden`, () => {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_RE)) {
        const specifier = match[1] as string;
        expect(FORBIDDEN_PACKAGES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(FORBIDDEN_MODULES, `${relative} imports ${specifier}`).not.toContain(specifier);
        expect(specifier.startsWith('../../')).toBe(false);
      }
      expect(source).not.toMatch(/\brequire\s*\(/);
      expect(source).not.toMatch(/[^.\w]import\s*\(/);
    });
  }

  it('depends exactly on shared', () => {
    const manifest = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@wizard-ads/shared']);
  });

  it('reads no credential from process.env', () => {
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/process\.env/);
  });
});
