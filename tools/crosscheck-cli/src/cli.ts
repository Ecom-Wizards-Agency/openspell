#!/usr/bin/env -S node --import tsx
/**
 * The operator's entry point.
 *
 * Four verbs, each one a thing somebody actually asks for:
 *
 *   scan         what is in the inbox and what each file claims to be
 *   ingest       compare one profile's exports now and record the verdicts
 *   report       print the verdict history for a profile
 *   exit-report  evaluate the v1 exit criterion and write the markdown
 *
 * `ingest` runs the same handler the worker runs, deliberately: an operator
 * reproducing a verdict by hand must exercise the code that produced it, not a
 * second implementation that agrees with it on a good day.
 */
import { writeFile } from 'node:fs/promises';
import { createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import {
  applySpendingFlags,
  evaluateExitCriterion,
  historiesFromResults,
  renderExitReport,
  spendingCampaignWeeks,
} from './exit-report.js';
import { runCrosscheckIngest } from './job.js';
import { scanInbox } from './inbox.js';
import { buildPanelModel } from './panel.js';
import { readCampaignNames, readProfile } from './facts.js';
import { readResults } from './results.js';

interface Args {
  command: string;
  flags: Map<string, string>;
  booleans: Set<string>;
}

const USAGE = `wizard-ads crosscheck

  scan         --inbox <dir> [--amazon-profile <id>]
  ingest       --profile <uuid> --path <file|dir> [--date YYYY-MM-DD]
               [--tolerance 0.07] [--archive] [--strict]
  report       --profile <uuid> [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  exit-report  [--profile <uuid>...] [--from] [--to] [--out FILE] [--strict]
               [--min-profiles 5] [--days 14] [--share 0.95]
               [--optimizer-parity-note "..."] [--optimizer-parity-failed]

The database comes from DATABASE_URL unless --database-url is given.
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === '' || args.booleans.has('help')) {
    process.stdout.write(USAGE);
    return args.command === '' ? 1 : 0;
  }

  if (args.command === 'scan') return scanCommand(args);

  const handle = createDb({
    connectionString: required(args, 'database-url', process.env['DATABASE_URL']),
    max: 2,
  });
  try {
    switch (args.command) {
      case 'ingest':
        return await ingestCommand(handle, args);
      case 'report':
        return await reportCommand(handle, args);
      case 'exit-report':
        return await exitReportCommand(handle, args);
      default:
        process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await handle.close();
  }
}

async function scanCommand(args: Args): Promise<number> {
  const inbox = required(args, 'inbox');
  const entries = await scanInbox(inbox, { amazonProfileId: args.flags.get('amazon-profile') });
  if (entries.length === 0) {
    process.stdout.write(`no exports matching the naming contract in ${inbox}\n`);
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(
      `${entry.name}\t${entry.file.grain}\t${entry.file.startDate}..${entry.file.endDate}\n`,
    );
  }
  process.stdout.write(`${entries.length} export(s)\n`);
  return 0;
}

async function ingestCommand(handle: DbHandle, args: Args): Promise<number> {
  const profileId = required(args, 'profile');
  const sourcePath = required(args, 'path');
  const date = args.flags.get('date') ?? today();
  const profile = await readProfile(handle, profileId);

  const result = await runCrosscheckIngest(
    handle,
    { type: 'crosscheck.ingest', orgId: profile.orgId, profileId, date, sourcePath },
    {
      tolerance: args.flags.has('tolerance') ? Number(args.flags.get('tolerance')) : undefined,
      archive: args.booleans.has('archive'),
    },
  );

  for (const file of result.files) {
    process.stdout.write(
      `${file.name}: ${file.rowsParsed} row(s) parsed, ${file.rowsKept} kept for this profile\n`,
    );
  }
  process.stdout.write(
    `${result.summary.profileDaysCompared} profile-day(s) compared, ` +
      `${result.summary.profileDaysSkipped} skipped as provisional; ` +
      `${result.summary.campaignsCompared} campaign(s) compared, ` +
      `${result.summary.campaignsSkippedIdle} idle; ` +
      `${result.written} verdict row(s) written.\n`,
  );
  process.stdout.write(`headline: ${result.summary.headline}\n`);
  return result.summary.headline === 'mismatch' && args.booleans.has('strict') ? 2 : 0;
}

async function reportCommand(handle: DbHandle, args: Args): Promise<number> {
  const profileId = required(args, 'profile');
  const rows = await readResults(handle, {
    profileId,
    startDate: args.flags.get('from'),
    endDate: args.flags.get('to'),
  });
  const names = await readCampaignNames(
    handle,
    profileId,
    [...new Set(rows.map((row) => row.entityId).filter((id): id is string => id !== null))],
  );
  const model = buildPanelModel(rows, { campaignNames: names, profileId });

  process.stdout.write(
    `verdict ${model.chip.verdict} as of ${model.chip.asOf ?? 'never'} ` +
      `(${model.chip.verifiedStreak} consecutive verified day(s))\n\n`,
  );
  process.stdout.write('date        verdict              ad_spend ours/theirs      delta\n');
  for (const day of model.days) {
    const spend = day.figures.find((figure) => figure.metric === 'ad_spend');
    process.stdout.write(
      `${day.date}  ${day.verdict.padEnd(20)} ` +
        `${fmt(spend?.ours)} / ${fmt(spend?.theirs)}`.padEnd(24) +
        `${pct(spend?.deltaPct)}\n`,
    );
  }

  if (model.mismatchingCampaigns.length > 0) {
    process.stdout.write('\ncampaign-week disagreements\n');
    for (const campaign of model.mismatchingCampaigns) {
      const spend = campaign.figures.find((figure) => figure.metric === 'ad_spend');
      process.stdout.write(
        `${campaign.weekStart}  ${campaign.campaignId}  ${campaign.campaignName ?? ''}  ` +
          `${campaign.verdict}  ${fmt(spend?.ours)} / ${fmt(spend?.theirs)}  ${pct(spend?.deltaPct)}\n`,
      );
    }
  }
  return 0;
}

async function exitReportCommand(handle: DbHandle, args: Args): Promise<number> {
  const rows = await readResults(handle, {
    startDate: args.flags.get('from'),
    endDate: args.flags.get('to'),
    profileId: args.flags.get('profile'),
  });

  const labels = new Map<string, { label: string; region: string | null }>();
  for (const profileId of new Set(rows.map((row) => row.profileId))) {
    const profile = await readProfile(handle, profileId);
    labels.set(profileId, {
      label: profile.accountLabel ?? profile.amazonProfileId,
      region: profile.region,
    });
  }

  const histories = applySpendingFlags(
    historiesFromResults(rows, labels),
    spendingCampaignWeeks(rows),
  );
  const report = evaluateExitCriterion(histories, {
    consecutiveDays: numberFlag(args, 'days'),
    minProfiles: numberFlag(args, 'min-profiles'),
    campaignShare: numberFlag(args, 'share'),
    optimizerParityNote: args.flags.get('optimizer-parity-note'),
    optimizerParityPassed: args.flags.has('optimizer-parity-note')
      ? !args.booleans.has('optimizer-parity-failed')
      : undefined,
  });

  const markdown = renderExitReport(report);
  const out = args.flags.get('out');
  if (out) await writeFile(out, markdown, 'utf8');
  else process.stdout.write(markdown);

  return report.verdict === 'pass' || !args.booleans.has('strict') ? 0 : 2;
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
  if (value === undefined || value === '') {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function numberFlag(args: Args, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return parsed;
}

function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? 'n/a' : value.toFixed(2);
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : `${(value * 100).toFixed(1)}%`;
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
