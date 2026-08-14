#!/usr/bin/env -S node --import tsx
/**
 * The operator's entry point for the AdLabs history backfill.
 *
 *   depth    what the timeline export holds, per profile, in months back
 *   phase0   load the profile-grain daily history into fact_profile_daily
 *   phase1   load one profile-month of one grain into fact_monthly_rollup
 *   verify   what is in the database from a backfill, read back
 *
 * Every verb that writes counts what it wrote against what it read and exits
 * non-zero when the two disagree. That is the whole discipline: a load whose
 * exit code is 0 because the process did not crash tells you nothing about
 * whether the rows arrived.
 *
 * The database comes from DATABASE_URL. It is never defaulted, never guessed,
 * and never read from a config file in this repo — the hosted project's
 * connection string is the operator's to supply.
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { appendManifest, sha256 } from './manifest.js';
import type { ManifestEntry } from './manifest.js';
import {
  loadProfileDays,
  loadRollupMonth,
  readBackfilledDepth,
  readProfileTargets,
} from './load.js';
import type { Phase0Result, Phase1Result } from './load.js';
import { BACKFILL_ROOT, parseBackfillFileName } from './naming.js';
import { ROLLUP_GRAINS, parseEntityExport } from './rollup.js';
import type { RollupGrain } from './rollup.js';
import { measureDepth, parseProfileRoster, parseProfileTimeline } from './timeline.js';

const USAGE = `wizard-ads adlabs backfill

  depth   --timeline <csv> [--as-of YYYY-MM-DD]
  phase0  --timeline <csv> --roster <csv> [--only <amazonProfileId>] [--dry-run]
          [--archive-root <dir>] [--as-of YYYY-MM-DD]
  phase1  --grain <campaign|target|placement|search_term> --file <csv>
          --profile <amazonProfileId> --start YYYY-MM-DD --end YYYY-MM-DD
          [--expect-spend N] [--expect-sales N] [--dry-run] [--archive-root <dir>]
  verify  [--profile <amazonProfileId>]

Exit code 2 means a count or a total did not reconcile. The database comes from
DATABASE_URL; there is no default.
`;

interface Args {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === '' || args.booleans.has('help')) {
    process.stdout.write(USAGE);
    return args.command === '' ? 1 : 0;
  }

  if (args.command === 'depth') return depthCommand(args);

  const handle = createDb({
    connectionString: required(args, 'database-url', process.env['DATABASE_URL']),
    max: 2,
    statementTimeoutSeconds: 600,
  });
  try {
    switch (args.command) {
      case 'phase0':
        return await phase0Command(handle, args);
      case 'phase1':
        return await phase1Command(handle, args);
      case 'verify':
        return await verifyCommand(handle, args);
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await handle.close();
  }
}

async function depthCommand(args: Args): Promise<number> {
  const path = required(args, 'timeline');
  const parsed = parseProfileTimeline(await readFile(path, 'utf8'));
  const asOf = args.flags.get('as-of') ?? today();

  process.stdout.write(
    `${parsed.rowsSeen} row(s) read, ${parsed.rowsZeroFilled} zero-filled, ` +
      `${parsed.byProfile.size} profile(s) with data\n\n`,
  );
  process.stdout.write('profile             months back   days with data   first        last\n');
  for (const depth of measureDepth(parsed, asOf)) {
    process.stdout.write(
      `${depth.amazonProfileId.padEnd(20)}${String(depth.monthsBack).padStart(11)}   ` +
        `${String(depth.daysWithData).padStart(14)}   ${depth.firstDate}   ${depth.lastDate}\n`,
    );
  }
  return 0;
}

async function phase0Command(handle: DbHandle, args: Args): Promise<number> {
  const timelinePath = required(args, 'timeline');
  const rosterPath = required(args, 'roster');
  const dryRun = args.booleans.has('dry-run');
  const only = args.flags.get('only');
  const now = args.flags.has('as-of') ? new Date(`${args.flags.get('as-of')}T12:00:00Z`) : new Date();

  const timelineText = await readFile(timelinePath, 'utf8');
  const parsed = parseProfileTimeline(timelineText);
  const roster = parseProfileRoster(await readFile(rosterPath, 'utf8'));
  const targets = await readProfileTargets(handle);

  process.stdout.write(
    `${parsed.rowsSeen} row(s) read, ${parsed.rowsZeroFilled} zero-filled, ` +
      `${parsed.byProfile.size} profile(s) with data, ${targets.size} onboarded\n`,
  );

  const results: Phase0Result[] = [];
  const skipped: string[] = [];
  let failures = 0;

  for (const [amazonProfileId, days] of [...parsed.byProfile].sort()) {
    if (only !== undefined && only !== amazonProfileId) continue;
    const target = targets.get(amazonProfileId);
    if (target === undefined) {
      skipped.push(amazonProfileId);
      continue;
    }

    const result = await loadProfileDays(handle, target, days, {
      adlabsCurrency: roster.get(amazonProfileId),
      now,
      dryRun,
    });
    results.push(result);

    process.stdout.write(
      `${amazonProfileId}: ${result.rowsOffered} day(s) with data, ` +
        `${result.rowsInProgress} in progress, ${result.rowsApiCovered} already ours, ` +
        `${result.rowsEligible} eligible, ${result.rowsLoaded} loaded` +
        `${result.firstDate ? ` (${result.firstDate}..${result.lastDate})` : ''}\n`,
    );
    if (result.currencyMismatch !== null) {
      process.stderr.write(
        `${amazonProfileId}: AdLabs says ${result.currencyMismatch}, ad_profiles says ` +
          `${target.currencyCode}. Loaded with ours; check the roster.\n`,
      );
      failures += 1;
    }
    if (!dryRun && result.rowsLoaded !== result.rowsEligible) {
      process.stderr.write(
        `${amazonProfileId}: ${result.rowsEligible} row(s) offered but ${result.rowsLoaded} loaded\n`,
      );
      failures += 1;
    }
  }

  if (skipped.length > 0) {
    process.stdout.write(
      `\n${skipped.length} profile(s) in the export are not in ad_profiles and were skipped\n`,
    );
  }

  const totals = results.reduce(
    (sum, row) => ({
      eligible: sum.eligible + row.rowsEligible,
      loaded: sum.loaded + row.rowsLoaded,
    }),
    { eligible: 0, loaded: 0 },
  );
  process.stdout.write(
    `\n${results.length} profile(s) loaded: ${totals.eligible} eligible, ${totals.loaded} written\n`,
  );

  if (!dryRun) {
    await record(args, timelinePath, timelineText, parsed.rowsSeen, {
      rowsEligible: totals.eligible,
      rowsLoaded: totals.loaded,
    });
  }

  return failures > 0 ? 2 : 0;
}

async function phase1Command(handle: DbHandle, args: Args): Promise<number> {
  const grain = required(args, 'grain') as RollupGrain;
  if (!ROLLUP_GRAINS.includes(grain)) {
    throw new Error(`--grain must be one of ${ROLLUP_GRAINS.join(', ')}`);
  }
  const path = required(args, 'file');
  const amazonProfileId = required(args, 'profile');
  const startDate = required(args, 'start');
  const endDate = required(args, 'end');
  const dryRun = args.booleans.has('dry-run');

  const targets = await readProfileTargets(handle);
  const target = targets.get(amazonProfileId);
  if (target === undefined) {
    throw new Error(`no ad_profiles row for Amazon profile ${amazonProfileId}`);
  }

  const text = await readFile(path, 'utf8');
  const parsed = parseEntityExport(grain, text);
  const result = await loadRollupMonth(handle, target, parsed, { startDate, endDate, dryRun });

  printPhase1(result);

  let failures = 0;
  if (!dryRun) {
    if (result.rowsLoaded !== result.rowsEligible) {
      process.stderr.write(
        `${result.rowsEligible} row(s) offered but ${result.rowsLoaded} loaded\n`,
      );
      failures += 1;
    }
    failures += compareCents('stored spend', result.storedTotals?.cost, result.fileTotals.cost);
    failures += compareCents('stored sales', result.storedTotals?.sales7d, result.fileTotals.sales7d);
    await record(args, path, text, parsed.rowsSeen, {
      rowsEligible: result.rowsEligible,
      rowsLoaded: result.rowsLoaded,
    });
  }

  failures += compareCents('AdLabs spend', result.fileTotals.cost, numberFlag(args, 'expect-spend'));
  failures += compareCents('AdLabs sales', result.fileTotals.sales7d, numberFlag(args, 'expect-sales'));

  return failures > 0 ? 2 : 0;
}

async function verifyCommand(handle: DbHandle, args: Args): Promise<number> {
  const only = args.flags.get('profile');
  const depths = await readBackfilledDepth(handle);
  process.stdout.write('profile              days   first        last\n');
  for (const depth of depths) {
    if (only !== undefined && only !== depth.amazonProfileId) continue;
    process.stdout.write(
      `${depth.amazonProfileId.padEnd(20)}${String(depth.days).padStart(5)}   ` +
        `${depth.firstDate}   ${depth.lastDate}\n`,
    );
  }

  const rollups = await handle.sql<
    { amazon_profile_id: string; grain: string; months: string; rows: string; cost: string }[]
  >`
    select p.amazon_profile_id,
           f.dimensions ->> 'grain' as grain,
           count(distinct f.month)::text as months,
           count(*)::text as rows,
           coalesce(sum(f.cost), 0)::text as cost
    from public.fact_monthly_rollup f
    join public.ad_profiles p on p.id = f.profile_id
    where f.source = 'adlabs_backfill'
    group by p.amazon_profile_id, f.dimensions ->> 'grain'
    order by p.amazon_profile_id, grain
  `;
  if (rollups.length > 0) {
    process.stdout.write('\nprofile              grain          months   rows      spend\n');
    for (const row of rollups) {
      if (only !== undefined && only !== row.amazon_profile_id) continue;
      process.stdout.write(
        `${row.amazon_profile_id.padEnd(20)}${row.grain.padEnd(15)}${row.months.padStart(6)}   ` +
          `${row.rows.padStart(6)}   ${Number(row.cost).toFixed(2)}\n`,
      );
    }
  }
  return 0;
}

function printPhase1(result: Phase1Result): void {
  process.stdout.write(
    `${result.amazonProfileId} ${result.grain} ${result.month} (${result.days} day(s)): ` +
      `${result.rowsSeen} row(s) read, ${result.rowsIdle} idle, ${result.rowsMerged} merged, ` +
      `${result.rowsEligible} eligible, ${result.rowsLoaded} loaded\n`,
  );
  process.stdout.write(
    `  file:   spend ${result.fileTotals.cost.toFixed(2)}  sales ${result.fileTotals.sales7d.toFixed(2)}  ` +
      `impressions ${result.fileTotals.impressions}  clicks ${result.fileTotals.clicks}  ` +
      `orders ${result.fileTotals.purchases7d}\n`,
  );
  if (result.storedTotals) {
    process.stdout.write(
      `  stored: spend ${result.storedTotals.cost.toFixed(2)}  sales ${result.storedTotals.sales7d.toFixed(2)}  ` +
        `impressions ${result.storedTotals.impressions}  clicks ${result.storedTotals.clicks}  ` +
        `orders ${result.storedTotals.purchases7d}\n`,
    );
  }
}

/** Cent-exact, because "close enough" is how a reconciliation stops meaning anything. */
function compareCents(what: string, left: number | undefined, right: number | undefined): number {
  if (left === undefined || right === undefined) return 0;
  const cents = (value: number) => Math.round(value * 100);
  if (cents(left) === cents(right)) return 0;
  process.stderr.write(`${what}: ${left.toFixed(2)} vs ${right.toFixed(2)}\n`);
  return 1;
}

/**
 * One manifest line for the file just loaded.
 *
 * The archived file's own name states its grain, scope and window, so the entry
 * is derived from it rather than from flags that could disagree with it. A file
 * that is not in the archive naming contract is loaded anyway and recorded as
 * `unarchived` — refusing would make the tool unusable on a file an operator
 * dropped somewhere sensible but non-standard, and the hash still pins it.
 */
async function record(
  args: Args,
  path: string,
  text: string,
  rows: number,
  counts: { rowsEligible: number; rowsLoaded: number },
): Promise<void> {
  const root = args.flags.get('archive-root') ?? BACKFILL_ROOT;
  const name = basename(path);
  const info = await stat(path);

  let described: Pick<ManifestEntry, 'grain' | 'scope' | 'startDate' | 'endDate'>;
  try {
    described = parseBackfillFileName(name);
  } catch {
    process.stderr.write(
      `${name} is not an adlabsbf_ archive name; recorded in the manifest as unarchived\n`,
    );
    described = { grain: 'profile', scope: 'unarchived', startDate: '1970-01-01', endDate: '1970-01-01' };
  }

  await appendManifest(root, {
    ...described,
    file: name,
    bytes: info.size,
    rows,
    sha256: sha256(text),
    pulledAt: info.mtime.toISOString(),
    loadedAt: new Date().toISOString(),
    ...counts,
  });
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  let command = '';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) {
      if (command === '') command = token;
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) booleans.add(name);
    else {
      flags.set(name, next);
      index += 1;
    }
  }

  return { command, flags, booleans };
}

function required(args: Args, name: string, fallback?: string): string {
  const value = args.flags.get(name) ?? fallback;
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

function numberFlag(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return parsed;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
