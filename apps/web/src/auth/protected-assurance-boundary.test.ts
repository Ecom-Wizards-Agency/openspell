import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), 'utf8');
}

describe('protected assurance boundary', () => {
  it('keeps route actors, Grid, and both Amazon OAuth endpoints on the shared role-aware gate', async () => {
    const files = await Promise.all([
      source('src/server/request-context.ts'),
      source('src/grid/request-context.ts'),
      source('app/api/amazon/oauth/start/route.ts'),
      source('app/api/amazon/oauth/callback/route.ts'),
    ]);
    for (const contents of files) {
      expect(contents).toContain('currentOperatorIdentity');
      expect(contents).toContain('authorizeOperatorRole');
    }
    expect(files[1]).toContain('enforceAssurance: enforceGridAssurance');
  });

  it('redirects every requestActor page through the structured auth continuation', async () => {
    const pagePaths = [
      'app/bugs/page.tsx',
      'app/campaigns/page.tsx',
      'app/experiments/new/page.tsx',
      'app/experiments/[experimentId]/page.tsx',
      'app/experiments/page.tsx',
      'app/feedback/new/page.tsx',
      'app/feedback/page.tsx',
      'app/ngrams/page.tsx',
      'app/query-intelligence/page.tsx',
      'app/recommendations/page.tsx',
      'app/roadmap/page.tsx',
      'app/tags/page.tsx',
      'app/time-machine/page.tsx',
    ];
    for (const path of pagePaths) {
      const contents = await source(path);
      expect(contents).toContain('requestActor(');
      expect(contents).toContain('authenticationDestination(error)');
    }
  });
});
