/**
 * Live smoke test. Operator-run, never run in CI.
 *
 * The fixture suite proves the client agrees with what Amazon documents. This
 * proves Amazon agrees with it. Two things in this package have never been
 * verified against a live account — report completion and download (the
 * reference's own poll timed out before a report finished) and the whole
 * Exports API contract (`_fetch_campaign_metadata` was left a stub for exactly
 * this reason) — and this script exercises both.
 *
 * Run it from the package directory:
 *
 *     pnpm smoke                       # uses _local/ads-api.config.json
 *     pnpm smoke path/to/config.json   # or an explicit path
 *
 * The configuration is gitignored; only `_local/ads-api.config.TEMPLATE.json`
 * is tracked. Copy the template, fill it in locally, and never paste a
 * credential anywhere else. This script prints ids, counts and byte sizes; it
 * never prints a token, and it makes no write call of any kind.
 *
 * It is read-only against Amazon, but it is not free: creating a report
 * consumes quota, so it creates exactly one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AdsApiClient } from '../src/client.js';
import { DuplicateReportError } from '../src/errors.js';
import { campaignNameIndex, isExportComplete, isExportFailed } from '../src/exports.js';
import {
  parseSbCampaignReport,
  parseSdCampaignReport,
  parseSpCampaignReport,
  parseSpPlacementReport,
  parseSpSearchTermReport,
  parseSpTargetingReport,
  type ParseResult,
} from '../src/parsers.js';
import { assertRegion, type ReportMetadata } from '../src/index.js';
import { isReportComplete, isTerminalFailure, type ReportSpec, REPORT_SPECS } from '../src/reports.js';
import type { ReportType } from '@wizard-ads/shared';

const DEFAULT_CONFIG = fileURLToPath(new URL('../../../_local/ads-api.config.json', import.meta.url));

interface SmokeConfig {
  lwa: { clientId: string; clientSecret: string; refreshToken: string };
  region: string;
  /** Amazon's profile id, as a string. Any profile the grant covers. */
  profileId: string;
  /** The single day to report on. Yesterday in the profile's timezone is ideal. */
  date: string;
  reportType?: string;
  /** Give up on polling after this many minutes. Amazon allows up to three hours. */
  maxWaitMinutes?: number;
  pollIntervalSeconds?: number;
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function loadConfig(path: string): SmokeConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    die(
      `missing ${path}. Copy _local/ads-api.config.TEMPLATE.json to _local/ads-api.config.json and fill it in.`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<SmokeConfig>;
  const lwa = parsed.lwa;
  if (lwa === undefined || !lwa.clientId || !lwa.clientSecret || !lwa.refreshToken) {
    die('config needs lwa.clientId, lwa.clientSecret and lwa.refreshToken');
  }
  if (!parsed.profileId) die('config needs profileId');
  if (!parsed.date) die('config needs date (YYYY-MM-DD)');
  return {
    lwa,
    region: parsed.region ?? 'NA',
    profileId: String(parsed.profileId),
    date: parsed.date,
    ...(parsed.reportType === undefined ? {} : { reportType: parsed.reportType }),
    ...(parsed.maxWaitMinutes === undefined ? {} : { maxWaitMinutes: parsed.maxWaitMinutes }),
    ...(parsed.pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds: parsed.pollIntervalSeconds }),
  };
}

function reportTypeOf(value: string | undefined): ReportType {
  const candidate = value ?? 'spCampaigns';
  if (candidate in REPORT_SPECS) return candidate as ReportType;
  die(`unknown reportType '${candidate}'. One of: ${Object.keys(REPORT_SPECS).join(', ')}`);
}

/** One parser per report shape; the smoke test uses whichever it asked for. */
function parseFor(reportType: ReportType, rows: Record<string, unknown>[]): ParseResult<unknown> {
  switch (reportType) {
    case 'spCampaigns':
      return parseSpCampaignReport(rows);
    case 'spTargeting':
      return parseSpTargetingReport(rows);
    case 'spSearchTerm':
      return parseSpSearchTermReport(rows);
    case 'spPlacement':
      return parseSpPlacementReport(rows);
    case 'sbCampaigns':
      return parseSbCampaignReport(rows);
    case 'sdCampaigns':
      return parseSdCampaignReport(rows);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? DEFAULT_CONFIG;
  const config = loadConfig(configPath);
  const region = assertRegion(config.region);
  const reportType = reportTypeOf(config.reportType);
  const spec: ReportSpec = REPORT_SPECS[reportType];
  const pollIntervalMs = (config.pollIntervalSeconds ?? 20) * 1_000;
  const deadline = Date.now() + (config.maxWaitMinutes ?? 45) * 60_000;

  const client = new AdsApiClient({
    credentials: {
      clientId: config.lwa.clientId,
      clientSecret: config.lwa.clientSecret,
      refreshToken: config.lwa.refreshToken,
    },
    region,
    userAgent: 'wizard-ads-smoke/0.1',
    onRetry: (event) =>
      console.log(
        `  retry: ${event.method} ${event.path} ${event.reason} status=${String(event.status)} ` +
          `wait=${event.delayMs}ms retryAfter=${String(event.retryAfterMs)}`,
      ),
  });

  console.log(`region ${region}, profile ${config.profileId}, ${reportType} for ${config.date}`);

  // 1. Profiles ------------------------------------------------------------
  console.log('\n[1/4] GET /v2/profiles');
  const profiles = await client.getProfiles();
  console.log(`  ${profiles.length} profiles on ${region}`);
  const scoped = profiles.find((profile) => profile.profileId === config.profileId);
  if (scoped === undefined) {
    console.log(`  WARNING: ${config.profileId} is not in this region's list; continuing anyway`);
  } else {
    console.log(
      `  target: ${scoped.profileId} ${scoped.countryCode ?? '?'} ${scoped.currencyCode ?? '?'} ` +
        `${scoped.timezone ?? '?'} ${scoped.accountType ?? '?'}`,
    );
  }

  // 2. Report: request -----------------------------------------------------
  console.log(`\n[2/4] POST /reporting/reports (${spec.reportTypeId}, groupBy ${spec.groupBy.join('+')})`);
  let reportId: string;
  try {
    const created = await client.createReport(config.profileId, {
      reportType,
      startDate: config.date,
      endDate: config.date,
    });
    reportId = created.reportId;
    console.log(`  reportId ${reportId} status ${created.status}`);
  } catch (error) {
    if (error instanceof DuplicateReportError && error.existingReportId !== null) {
      reportId = error.existingReportId;
      console.log(`  425 duplicate: adopting in-flight report ${reportId}`);
    } else {
      throw error;
    }
  }

  // 3. Report: poll and download -------------------------------------------
  console.log('\n[3/4] polling');
  let metadata: ReportMetadata = await client.getReport(config.profileId, reportId);
  while (!isReportComplete(metadata.status) && !isTerminalFailure(metadata.status)) {
    if (Date.now() > deadline) {
      die(`report ${reportId} still ${metadata.status} after the configured wait; re-run to resume polling`);
    }
    console.log(`  ${new Date().toISOString()} ${metadata.status}`);
    await sleep(pollIntervalMs);
    metadata = await client.getReport(config.profileId, reportId);
  }
  if (isTerminalFailure(metadata.status)) {
    die(`report ${reportId} ended ${metadata.status}: ${metadata.failureReason ?? 'no reason given'}`);
  }
  if (metadata.url === null) die(`report ${reportId} is COMPLETED with no download url`);

  console.log(`  COMPLETED, fileSize ${String(metadata.fileSize)}`);
  const download = await client.downloadReport(metadata.url);
  const parsed = parseFor(reportType, download.rows);

  console.log(
    `  downloaded ${download.payload.downloadedBytes} bytes ` +
      `(${download.payload.gzipped ? 'gzip' : 'plain'}) -> ${download.payload.decodedBytes} bytes`,
  );
  console.log(`  rows downloaded ${download.rows.length}`);
  console.log(`  rows parsed     ${parsed.rows.length}`);
  console.log(`  rows skipped    ${parsed.skipped.length}`);
  for (const skip of parsed.skipped.slice(0, 5)) {
    console.log(`    row ${skip.index}: ${skip.reason}`);
  }
  if (parsed.rows.length + parsed.skipped.length !== download.rows.length) {
    die('parsed + skipped does not equal downloaded: rows were lost');
  }
  if (download.rows.length > 0) {
    console.log(`  first raw row keys: ${Object.keys(download.rows[0] ?? {}).sort().join(', ')}`);
  }

  // 4. Exports: the campaign-name join -------------------------------------
  console.log('\n[4/4] Exports API (campaign name join) — UNVERIFIED contract, report anything odd');
  const created = await client.createExport(config.profileId, {
    kind: 'campaigns',
    adProducts: [spec.adProduct],
  });
  console.log(`  exportId ${created.exportId} status ${created.status}`);
  let exportMeta = await client.getExport(config.profileId, created.exportId);
  while (!isExportComplete(exportMeta.status) && !isExportFailed(exportMeta.status)) {
    if (Date.now() > deadline) die(`export ${created.exportId} still ${exportMeta.status}; giving up`);
    console.log(`  ${new Date().toISOString()} ${exportMeta.status}`);
    await sleep(pollIntervalMs);
    exportMeta = await client.getExport(config.profileId, created.exportId);
  }
  if (isExportFailed(exportMeta.status)) {
    die(`export ${created.exportId} ended ${exportMeta.status}: ${exportMeta.error ?? 'no reason given'}`);
  }
  if (exportMeta.url === null) die(`export ${created.exportId} is COMPLETED with no download url`);

  const exportDownload = await client.downloadExport(exportMeta.url);
  const names = campaignNameIndex(exportDownload.rows);
  console.log(
    `  downloaded ${exportDownload.payload.downloadedBytes} bytes ` +
      `(${exportDownload.payload.gzipped ? 'gzip' : 'plain'}), ${exportDownload.rows.length} rows`,
  );
  console.log(`  campaign id -> name entries: ${names.size}`);
  if (exportDownload.rows.length > 0) {
    console.log(`  first export row keys: ${Object.keys(exportDownload.rows[0] ?? {}).sort().join(', ')}`);
  }

  // The join is the whole reason the export exists: how many report rows can
  // now be labelled with a real campaign name?
  const reportCampaignIds = new Set(
    download.rows
      .map((row) => row['campaignId'])
      .filter((value): value is string | number => value !== undefined && value !== null)
      .map((value) => String(value)),
  );
  const joined = [...reportCampaignIds].filter((id) => names.has(id)).length;
  console.log(
    `  join coverage: ${joined}/${reportCampaignIds.size} campaign ids in the report have a name`,
  );

  console.log(`\nthrottle: ${JSON.stringify(client.throttleState)}`);
  console.log('done');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
