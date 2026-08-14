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
 *     pnpm smoke --writes              # DANGEROUS: configured sandbox writes
 *
 * The configuration is gitignored; only `_local/ads-api.config.TEMPLATE.json`
 * is tracked. Copy the template, fill it in locally, and never paste a
 * credential anywhere else. This script prints ids, counts and byte sizes; it
 * never prints a token. Amazon mutation calls are unreachable unless the
 * operator passes `--writes` and supplies explicit batches under `writes`.
 *
 * Default mode is read-only against Amazon, but it is not free: creating a
 * report consumes quota, so it creates exactly one.
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
import type {
  SpAdGroupCreateInput,
  SpAdGroupUpdateInput,
  SpBatchWriteResult,
  SpCampaignCreateInput,
  SpCampaignNegativeKeywordCreateInput,
  SpCampaignNegativeKeywordUpdateInput,
  SpCampaignNegativeTargetCreateInput,
  SpCampaignNegativeTargetUpdateInput,
  SpCampaignPlacementUpdateInput,
  SpCampaignUpdateInput,
  SpKeywordCreateInput,
  SpKeywordUpdateInput,
  SpNegativeKeywordCreateInput,
  SpNegativeKeywordUpdateInput,
  SpNegativeTargetCreateInput,
  SpNegativeTargetUpdateInput,
  SpProductAdCreateInput,
  SpProductAdUpdateInput,
  SpTargetCreateInput,
  SpTargetUpdateInput,
} from '../src/writes.js';

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
  /** Explicit operator-authored sandbox batches; ignored unless `--writes` is passed. */
  writes?: WriteSmokeConfig;
}

interface WriteOperations<Create, Update> {
  create?: readonly Create[];
  update?: readonly Update[];
  archive?: readonly string[];
}

interface WriteSmokeConfig {
  campaigns?: WriteOperations<SpCampaignCreateInput, SpCampaignUpdateInput> & {
    placement?: readonly SpCampaignPlacementUpdateInput[];
  };
  adGroups?: WriteOperations<SpAdGroupCreateInput, SpAdGroupUpdateInput>;
  keywords?: WriteOperations<SpKeywordCreateInput, SpKeywordUpdateInput>;
  targets?: WriteOperations<SpTargetCreateInput, SpTargetUpdateInput>;
  negativeKeywords?: WriteOperations<SpNegativeKeywordCreateInput, SpNegativeKeywordUpdateInput>;
  campaignNegativeKeywords?: WriteOperations<
    SpCampaignNegativeKeywordCreateInput,
    SpCampaignNegativeKeywordUpdateInput
  >;
  negativeTargets?: WriteOperations<SpNegativeTargetCreateInput, SpNegativeTargetUpdateInput>;
  campaignNegativeTargets?: WriteOperations<
    SpCampaignNegativeTargetCreateInput,
    SpCampaignNegativeTargetUpdateInput
  >;
  productAds?: WriteOperations<SpProductAdCreateInput, SpProductAdUpdateInput>;
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
    ...(parsed.writes === undefined ? {} : { writes: parsed.writes }),
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

function printWriteResult(label: string, result: SpBatchWriteResult): void {
  console.log(
    `  ${label}: ${result.items.length} ok, ${result.errors.length} errors, ` +
      `${result.submitted} submitted across ${result.batches} batches`,
  );
  if (result.items.length + result.errors.length !== result.submitted) {
    die(`${label}: items + errors does not equal submitted`);
  }
  for (const error of result.errors) {
    console.log(`    index ${error.index}: ${error.code ?? 'UNKNOWN'} ${error.details ?? ''}`.trimEnd());
  }
}

async function runConfiguredWrites(
  client: AdsApiClient,
  profileId: string,
  writes: WriteSmokeConfig,
): Promise<void> {
  console.log('\n[WRITES] OPERATOR-ONLY sandbox mutations');
  const calls: Array<{ label: string; count: number; run: () => Promise<SpBatchWriteResult> }> = [
    { label: 'campaigns.create', count: writes.campaigns?.create?.length ?? 0, run: () => client.createSpCampaigns(profileId, writes.campaigns?.create ?? []) },
    { label: 'campaigns.update', count: writes.campaigns?.update?.length ?? 0, run: () => client.updateSpCampaigns(profileId, writes.campaigns?.update ?? []) },
    { label: 'campaigns.placement', count: writes.campaigns?.placement?.length ?? 0, run: () => client.updateSpCampaignPlacementBidding(profileId, writes.campaigns?.placement ?? []) },
    { label: 'campaigns.archive', count: writes.campaigns?.archive?.length ?? 0, run: () => client.archiveSpCampaigns(profileId, writes.campaigns?.archive ?? []) },
    { label: 'adGroups.create', count: writes.adGroups?.create?.length ?? 0, run: () => client.createSpAdGroups(profileId, writes.adGroups?.create ?? []) },
    { label: 'adGroups.update', count: writes.adGroups?.update?.length ?? 0, run: () => client.updateSpAdGroups(profileId, writes.adGroups?.update ?? []) },
    { label: 'adGroups.archive', count: writes.adGroups?.archive?.length ?? 0, run: () => client.archiveSpAdGroups(profileId, writes.adGroups?.archive ?? []) },
    { label: 'keywords.create', count: writes.keywords?.create?.length ?? 0, run: () => client.createSpKeywords(profileId, writes.keywords?.create ?? []) },
    { label: 'keywords.update', count: writes.keywords?.update?.length ?? 0, run: () => client.updateSpKeywords(profileId, writes.keywords?.update ?? []) },
    { label: 'keywords.archive', count: writes.keywords?.archive?.length ?? 0, run: () => client.archiveSpKeywords(profileId, writes.keywords?.archive ?? []) },
    { label: 'targets.create', count: writes.targets?.create?.length ?? 0, run: () => client.createSpTargets(profileId, writes.targets?.create ?? []) },
    { label: 'targets.update', count: writes.targets?.update?.length ?? 0, run: () => client.updateSpTargets(profileId, writes.targets?.update ?? []) },
    { label: 'targets.archive', count: writes.targets?.archive?.length ?? 0, run: () => client.archiveSpTargets(profileId, writes.targets?.archive ?? []) },
    { label: 'negativeKeywords.create', count: writes.negativeKeywords?.create?.length ?? 0, run: () => client.createSpNegativeKeywords(profileId, writes.negativeKeywords?.create ?? []) },
    { label: 'negativeKeywords.update', count: writes.negativeKeywords?.update?.length ?? 0, run: () => client.updateSpNegativeKeywords(profileId, writes.negativeKeywords?.update ?? []) },
    { label: 'negativeKeywords.archive', count: writes.negativeKeywords?.archive?.length ?? 0, run: () => client.archiveSpNegativeKeywords(profileId, writes.negativeKeywords?.archive ?? []) },
    { label: 'campaignNegativeKeywords.create', count: writes.campaignNegativeKeywords?.create?.length ?? 0, run: () => client.createSpCampaignNegativeKeywords(profileId, writes.campaignNegativeKeywords?.create ?? []) },
    { label: 'campaignNegativeKeywords.update', count: writes.campaignNegativeKeywords?.update?.length ?? 0, run: () => client.updateSpCampaignNegativeKeywords(profileId, writes.campaignNegativeKeywords?.update ?? []) },
    { label: 'campaignNegativeKeywords.archive', count: writes.campaignNegativeKeywords?.archive?.length ?? 0, run: () => client.archiveSpCampaignNegativeKeywords(profileId, writes.campaignNegativeKeywords?.archive ?? []) },
    { label: 'negativeTargets.create', count: writes.negativeTargets?.create?.length ?? 0, run: () => client.createSpNegativeTargets(profileId, writes.negativeTargets?.create ?? []) },
    { label: 'negativeTargets.update', count: writes.negativeTargets?.update?.length ?? 0, run: () => client.updateSpNegativeTargets(profileId, writes.negativeTargets?.update ?? []) },
    { label: 'negativeTargets.archive', count: writes.negativeTargets?.archive?.length ?? 0, run: () => client.archiveSpNegativeTargets(profileId, writes.negativeTargets?.archive ?? []) },
    { label: 'campaignNegativeTargets.create', count: writes.campaignNegativeTargets?.create?.length ?? 0, run: () => client.createSpCampaignNegativeTargets(profileId, writes.campaignNegativeTargets?.create ?? []) },
    { label: 'campaignNegativeTargets.update', count: writes.campaignNegativeTargets?.update?.length ?? 0, run: () => client.updateSpCampaignNegativeTargets(profileId, writes.campaignNegativeTargets?.update ?? []) },
    { label: 'campaignNegativeTargets.archive', count: writes.campaignNegativeTargets?.archive?.length ?? 0, run: () => client.archiveSpCampaignNegativeTargets(profileId, writes.campaignNegativeTargets?.archive ?? []) },
    { label: 'productAds.create', count: writes.productAds?.create?.length ?? 0, run: () => client.createSpProductAds(profileId, writes.productAds?.create ?? []) },
    { label: 'productAds.update', count: writes.productAds?.update?.length ?? 0, run: () => client.updateSpProductAds(profileId, writes.productAds?.update ?? []) },
    { label: 'productAds.archive', count: writes.productAds?.archive?.length ?? 0, run: () => client.archiveSpProductAds(profileId, writes.productAds?.archive ?? []) },
  ];
  const configured = calls.filter((call) => call.count > 0);
  if (configured.length === 0) die('--writes was passed, but config.writes contains no mutation items');
  for (const call of configured) printWriteResult(call.label, await call.run());
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const writesEnabled = args.includes('--writes');
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--writes');
  if (unknownFlags.length > 0) die(`unknown option(s): ${unknownFlags.join(', ')}`);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1) die('pass at most one config path');
  const configPath = positional[0] ?? DEFAULT_CONFIG;
  const config = loadConfig(configPath);
  const region = assertRegion(config.region);
  const reportType = reportTypeOf(config.reportType);
  const spec: ReportSpec = REPORT_SPECS[reportType];
  const pollIntervalMs = (config.pollIntervalSeconds ?? 20) * 1_000;
  const deadline = Date.now() + (config.maxWaitMinutes ?? 45) * 60_000;

  // Destructured and passed by shorthand: the public-repo hygiene scanner
  // cannot tell a long right-hand side next to a credential-shaped key from a
  // hardcoded one, and a linter nobody can silence is worth a rename.
  const { clientId, clientSecret, refreshToken } = config.lwa;
  const client = new AdsApiClient({
    credentials: { clientId, clientSecret, refreshToken },
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
  let exportMeta = await client.getExport(config.profileId, created.exportId, 'campaigns');
  while (!isExportComplete(exportMeta.status) && !isExportFailed(exportMeta.status)) {
    if (Date.now() > deadline) die(`export ${created.exportId} still ${exportMeta.status}; giving up`);
    console.log(`  ${new Date().toISOString()} ${exportMeta.status}`);
    await sleep(pollIntervalMs);
    exportMeta = await client.getExport(config.profileId, created.exportId, 'campaigns');
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

  if (writesEnabled) {
    if (config.writes === undefined) die('--writes requires an explicit writes object in the config');
    await runConfiguredWrites(client, config.profileId, config.writes);
  }

  console.log(`\nthrottle: ${JSON.stringify(client.throttleState)}`);
  console.log('done');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
