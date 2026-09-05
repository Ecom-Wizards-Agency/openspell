import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JobPayload, JobType } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import * as rootDatabase from './index.js';
import { syncJobType } from './schema/enums.js';
import * as persistence from './sp-write-persistence.js';
import * as workerDatabase from './worker.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APPLICATION_CONSUMERS = [
  'apps/web/app/api/sp-writes/approve/route.ts',
  'apps/web/app/api/sp-writes/inverse-preview/route.ts',
  'apps/web/app/api/sp-writes/preview/route.ts',
  'apps/web/app/api/sp-writes/status/route.ts',
  'apps/web/src/writes/http.ts',
].map((path) => `${REPO_ROOT}${path}`);

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [
      '.git', '.next', '.turbo', 'coverage', 'dist', 'node_modules',
    ].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (
      /\.(?:ts|tsx|js|mjs|cjs|json|sql|toml|ya?ml|sh|service)$/.test(entry.name)
      || /^Dockerfile(?:\.|$)/u.test(entry.name)
    ) files.push(path);
  }
  return files;
}

describe('SP write persistence facade blast radius', () => {
  it('resolves only through the explicit subpath surface', async () => {
    expect(persistence.createSpWriteStagingLedger).toBeTypeOf('function');
    expect(persistence.createSpWriteRuntimeLedger).toBeTypeOf('function');
    expect(persistence.createSpWriteOutboxLedger).toBeTypeOf('function');
    expect(persistence.SpWritePersistenceError).toBeTypeOf('function');

    for (const symbol of [
      'createSpWriteStagingLedger',
      'createSpWriteRuntimeLedger',
      'createSpWriteOutboxLedger',
      'SpWritePersistenceError',
    ]) {
      expect(symbol in rootDatabase).toBe(false);
      expect(symbol in workerDatabase).toBe(false);
    }

    const manifest = JSON.parse(
      await readFile(`${REPO_ROOT}packages/db/package.json`, 'utf8'),
    ) as { exports?: Record<string, string> };
    expect(manifest.exports?.['./sp-write-persistence'])
      .toBe('./src/sp-write-persistence.ts');
    expect(Object.entries(manifest.exports ?? {}).filter(([, target]) =>
      target.includes('sp-write-persistence'))).toEqual([
      ['./sp-write-persistence', './src/sp-write-persistence.ts'],
    ]);
  });

  it('keeps current job contracts and the database queue enum SP-write-free', () => {
    const syntheticBase = {
      orgId: '00000000-0000-4000-8000-000000000001',
      profileId: '00000000-0000-4000-8000-000000000002',
    };
    expect(JobPayload.safeParse({
      ...syntheticBase,
      type: 'sp_write.dispatch',
      planId: '00000000-0000-4000-8000-000000000003',
    }).success).toBe(false);
    expect(JobPayload.safeParse({
      ...syntheticBase,
      type: 'sp_write.observe',
      intentId: '00000000-0000-4000-8000-000000000004',
    }).success).toBe(false);
    expect(JobType.options.some((value) => value.startsWith('sp_write.'))).toBe(false);
    expect(syncJobType.enumValues.some((value) => value.startsWith('sp_write.'))).toBe(false);
  });

  it('has no current app consumer or provider/runtime dependency', async () => {
    const appRoots = ['apps/worker', 'apps/web', 'apps/mcp', 'apps/analyst']
      .map((path) => `${REPO_ROOT}${path}`);
    const appFiles = (await Promise.all(appRoots.map(sourceFiles))).flat();
    expect(appFiles.length).toBeGreaterThan(100);
    const consumers: string[] = [];
    const applicationConsumers: string[] = [];
    for (const path of appFiles) {
      const text = await readFile(path, 'utf8');
      if (text.includes('@wizard-ads/db/sp-write-persistence')) consumers.push(path);
      if (text.includes('@wizard-ads/db/sp-write-application')) applicationConsumers.push(path);
    }
    expect(consumers).toEqual([]);
    expect(applicationConsumers.sort()).toEqual(APPLICATION_CONSUMERS);

    const productionFiles = [
      `${REPO_ROOT}packages/db/src/sp-write-persistence.ts`,
      `${REPO_ROOT}packages/db/src/queries/sp-write-persistence.ts`,
    ];
    const productionText = (await Promise.all(
      productionFiles.map((path) => readFile(path, 'utf8')),
    )).join('\n');
    for (const forbidden of [
      '@wizard-ads/ads-api',
      'sp-write-adapter',
      'approve_sp_write_cycle',
      'claim_sync_jobs',
      'enqueue_due_schedules',
      'finish_sync_job',
      'JobPayload',
      'set_config(\'request.jwt.claims\'',
      'set role authenticated',
    ]) {
      expect(productionText).not.toContain(forbidden);
    }
    expect(productionText).not.toMatch(/\bfetch\s*\(/);
  });

  it('finds no operational activation in apps, CI, seeds, or deployment surfaces', async () => {
    const roots = [
      'apps',
      '.github',
      'supabase/seed',
      'supabase/functions',
      'docs/deploy',
    ].map((path) => `${REPO_ROOT}${path}`);
    const rootOperationalFiles = [
      'package.json',
      'pnpm-workspace.yaml',
      'turbo.json',
      'supabase/config.toml',
    ].map((path) => `${REPO_ROOT}${path}`);
    const operationalFiles = [
      ...(await Promise.all(roots.map(sourceFiles))).flat(),
      ...rootOperationalFiles,
    ];
    expect(operationalFiles.length).toBeGreaterThan(150);

    const activationMarkers = [
      'sp_write_',
      'SP_WRITE',
      'sp-write-persistence',
      '@wizard-ads/db/sp-write-application',
      'sp-write-adapter',
      '@wizard-ads/db/sp-write-persistence',
      '@wizard-ads/ads-api/sp-write-adapter',
      'createSpWriteRuntimeLedger',
      'createSpWriteStagingLedger',
      'createSpWriteOutboxLedger',
      'record_sp_write_plan',
      'reserve_sp_write_provider_call',
      'sp_write.dispatch',
      'sp_write.observe',
      'OPEN_SPELL_SP_WRITE',
    ];
    const matches: Array<{ path: string; marker: string }> = [];
    for (const path of operationalFiles) {
      const source = await readFile(path, 'utf8');
      for (const marker of activationMarkers) {
        if (marker === '@wizard-ads/db/sp-write-application' && APPLICATION_CONSUMERS.includes(path)) continue;
        if (marker === 'sp_write_' && path === `${REPO_ROOT}apps/web/src/writes/http.test.ts`) continue;
        if (source.includes(marker)) matches.push({ path, marker });
      }
    }
    expect(matches).toEqual([]);

    const migrations = await sourceFiles(`${REPO_ROOT}supabase/migrations`);
    const inertSpWriteMigrationSuffixes = [
      '/20260901020000_sp_write_persistence_ledger.sql',
      '/20260901030000_sp_write_outbox_delivery.sql',
      '/20260905000000_sp_write_preview_evidence.sql',
      '/20260905010000_sp_write_preview_approval.sql',
      '/20260905020000_sp_write_application_entry.sql',
    ];
    const inertSpWriteMigrations = migrations.filter((path) =>
      inertSpWriteMigrationSuffixes.some((suffix) => path.endsWith(suffix)));
    expect(inertSpWriteMigrations.map((path) => `/${path.split('/').at(-1)}`).sort())
      .toEqual([...inertSpWriteMigrationSuffixes].sort());
    const nonLedgerMigrations = migrations.filter((path) =>
      !inertSpWriteMigrations.includes(path));
    expect(nonLedgerMigrations.length).toBeGreaterThan(25);
    const activatedMigrations: Array<{ path: string; marker: string }> = [];
    for (const path of nonLedgerMigrations) {
      const source = await readFile(path, 'utf8');
      for (const marker of activationMarkers) {
        if (source.includes(marker)) activatedMigrations.push({ path, marker });
      }
    }
    expect(activatedMigrations).toEqual([]);

    const packageManifests = (await sourceFiles(`${REPO_ROOT}packages`))
      .filter((path) => path.endsWith('/package.json'))
      .filter((path) => path !== `${REPO_ROOT}packages/db/package.json`);
    expect(packageManifests.length).toBeGreaterThan(5);
    const manifestConsumers: string[] = [];
    for (const path of packageManifests) {
      if ((await readFile(path, 'utf8')).includes('@wizard-ads/db/sp-write-persistence')) {
        manifestConsumers.push(path);
      }
    }
    expect(manifestConsumers).toEqual([]);
  });
});
