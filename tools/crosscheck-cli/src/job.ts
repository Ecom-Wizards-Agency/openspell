/**
 * The `crosscheck.ingest` job handler.
 *
 * This is the whole handler, not a fragment of one: the worker (WP-03) owns the
 * claim loop, the retry policy and the logging, and calls `runCrosscheckIngest`
 * with a claimed payload and a database handle. Keeping the logic here means
 * the two packages can be built and tested in parallel without either editing
 * the other's files, and the handler can be run from the CLI against the same
 * code path an operator will later blame for a verdict.
 *
 * `docs/handoffs-to-wp03.md` is the integration note.
 */
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { CrosscheckIngestJob } from '@wizard-ads/shared';
import type { DbHandle } from '@wizard-ads/db';
import { compare } from './compare.js';
import type { CompareSummary, CrosscheckFinding } from './compare.js';
import { isExportFileName, parseExport, parseExportFileName } from './contract.js';
import type { ParsedExport } from './contract.js';
import { readOurCampaignTotals, readOurProfileDays, readProfile } from './facts.js';
import type { ProfileIdentity } from './facts.js';
import { markProcessed, readExportFile, scanInbox } from './inbox.js';
import type { InboxEntry } from './inbox.js';
import { writeFindings } from './results.js';

export interface CrosscheckIngestOptions {
  tolerance?: number;
  /**
   * The day the exports were pulled: that day and later are in-progress on the
   * AdLabs side. Defaults to the job's `date`, which a nightly pull sets to the
   * day it runs.
   */
  reportDay?: string;
  /** Move ingested exports into `processed/`. Off in tests, on in the worker. */
  archive?: boolean;
  /** Groups every row this run wrote. */
  runId?: string;
}

export interface CrosscheckIngestResult {
  profile: ProfileIdentity;
  /** Exports read, in the order they were ingested. */
  files: { name: string; grain: string; rowsParsed: number; rowsKept: number }[];
  filesParsed: number;
  rowsParsed: number;
  rowsKept: number;
  findings: CrosscheckFinding[];
  summary: CompareSummary;
  written: number;
}

export class NoExportsFound extends Error {
  constructor(sourcePath: string) {
    super(
      `no AdLabs export matching the naming contract at ${sourcePath}. ` +
        'Expected adlabs_<grain>_<profileId>_<start>_<end>.csv.',
    );
    this.name = 'NoExportsFound';
  }
}

/**
 * Ingest every export the job points at, compare, and record the verdicts.
 *
 * `sourcePath` is either one export or a directory to scan. A directory is the
 * normal case: the profile-grain and campaign-grain exports for one night
 * arrive together and belong in one comparison.
 */
export async function runCrosscheckIngest(
  handle: DbHandle,
  job: CrosscheckIngestJob,
  options: CrosscheckIngestOptions = {},
): Promise<CrosscheckIngestResult> {
  const profile = await readProfile(handle, job.profileId);
  const entries = await resolveEntries(job.sourcePath, profile.amazonProfileId);
  if (entries.length === 0) throw new NoExportsFound(job.sourcePath);

  const parsed: ParsedExport[] = [];
  for (const entry of entries) {
    const text = await readExportFile(entry);
    parsed.push(parseExport(entry.name, text, { amazonProfileId: profile.amazonProfileId }));
  }

  const profileExports = parsed.filter((exported) => exported.file.grain === 'profile');
  const campaignExports = parsed.filter((exported) => exported.file.grain === 'campaign');

  const findings: CrosscheckFinding[] = [];
  const summaries: CompareSummary[] = [];
  const reportDay = options.reportDay ?? job.date;

  for (const exported of profileExports) {
    const ours = await readOurProfileDays(
      handle,
      job.profileId,
      exported.file.startDate,
      exported.file.endDate,
    );
    const result = compare(
      {
        profile: { ours, theirs: exported.profileDays, source: exported.source },
      },
      { tolerance: options.tolerance, reportDay, source: exported.source },
    );
    findings.push(...result.findings);
    summaries.push(result.summary);
  }

  for (const exported of campaignExports) {
    const ours = await readOurCampaignTotals(
      handle,
      job.profileId,
      exported.file.startDate,
      exported.file.endDate,
    );
    const result = compare(
      {
        campaign: {
          weekStart: exported.file.startDate,
          ours,
          theirs: exported.campaigns,
          source: exported.source,
        },
      },
      { tolerance: options.tolerance, reportDay, source: exported.source },
    );
    findings.push(...result.findings);
    summaries.push(result.summary);
  }

  const written = await writeFindings(
    handle,
    { orgId: profile.orgId, profileId: profile.profileId, runId: options.runId },
    findings,
  );

  if (options.archive === true) {
    for (const entry of entries) await markProcessed(dirname(entry.path), entry);
  }

  return {
    profile,
    files: parsed.map((exported) => ({
      name: exported.source,
      grain: exported.file.grain,
      rowsParsed: exported.rowsParsed,
      rowsKept: exported.rowsKept,
    })),
    filesParsed: parsed.length,
    rowsParsed: parsed.reduce((total, exported) => total + exported.rowsParsed, 0),
    rowsKept: parsed.reduce((total, exported) => total + exported.rowsKept, 0),
    findings,
    summary: mergeSummaries(summaries),
    written: written.written,
  };
}

async function resolveEntries(sourcePath: string, amazonProfileId: string): Promise<InboxEntry[]> {
  const info = await stat(sourcePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return [];

  if (info.isDirectory()) return scanInbox(sourcePath, { amazonProfileId });

  const name = basename(sourcePath);
  if (!isExportFileName(name)) return [];
  return [{ path: sourcePath, name, file: parseExportFileName(name) }];
}

function mergeSummaries(summaries: readonly CompareSummary[]): CompareSummary {
  const headlines = summaries.map((summary) => summary.headline);
  return {
    profileDaysCompared: sum(summaries.map((s) => s.profileDaysCompared)),
    profileDaysSkipped: sum(summaries.map((s) => s.profileDaysSkipped)),
    campaignsCompared: sum(summaries.map((s) => s.campaignsCompared)),
    campaignsSkippedIdle: sum(summaries.map((s) => s.campaignsSkippedIdle)),
    headline: headlines.includes('mismatch')
      ? 'mismatch'
      : headlines.includes('missing_ours')
        ? 'missing_ours'
        : headlines.includes('missing_theirs')
          ? 'missing_theirs'
          : headlines.includes('verified')
            ? 'verified'
            : 'no_data',
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
