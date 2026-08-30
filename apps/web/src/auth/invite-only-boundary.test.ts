import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

describe('invite-only identity boundary', () => {
  it('keeps account creation in invitation acceptance and disables OTP signup', async () => {
    const appRoot = resolve(process.cwd(), 'app');
    const files = await sourceFiles(appRoot);
    const sources = await Promise.all(files.map(async (path) => ({
      path: relative(appRoot, path),
      source: await readFile(path, 'utf8'),
    })));
    expect(
      sources.filter(({ source }) => source.includes('auth.admin.createUser')).map(({ path }) => path),
    ).toEqual([join('invite', '[token]', 'actions.ts')]);

    const login = sources.find(({ path }) => path === join('login', 'actions.ts'))?.source;
    expect(login).toContain('shouldCreateUser: false');
    expect(sources.some(({ source }) => source.includes('.signUp('))).toBe(false);
  });
});
