import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  parseSpCampaignReport,
  parseSpPlacementReport,
  parseSpSearchTermReport,
  parseSpTargetingReport,
} from '@wizard-ads/ads-api';
import type { SkippedReportRow } from '@wizard-ads/ads-api';
import type {
  NewPlacementFact,
  NewProfileFact,
  NewSearchTermFact,
  NewSpTargetFact,
} from '@wizard-ads/db';
import type { ReportType } from '@wizard-ads/shared';
import type { AdsProfileContext } from './ads-api.js';

/**
 * Legacy SB/SD refusal threshold. Sponsored Products replacement is stricter:
 * one refused source row blocks the complete-date replacement.
 */
export const SKIP_FAILURE_RATIO = 0.01;

interface CommonRow { date: string; impressions: number; clicks: number; cost: number }
interface SpCampaignRow extends CommonRow { campaignId: string; purchases7d: number; sales7d: number; unitsSoldClicks7d: number }
interface CampaignRow extends SpCampaignRow { adGroupId: string | null }

export interface CampaignFactRow {
  orgId: string;
  profileId: string;
  date: string;
  campaignId: string;
  adGroupId: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
  metrics: Record<string, unknown>;
  reportRequestId: string;
}

/**
 * `sourceRows` is how many rows Amazon sent; `rows` is how many fact rows they
 * became; `skipped` is what a parser refused and why.
 *
 * The three differ in two ways. `spCampaigns` arrives per campaign and lands on
 * a per-profile grain, so it aggregates and `rows` is smaller by design.
 * `spTargeting` and `spSearchTerm` are parsed by `@wizard-ads/ads-api`, which
 * refuses a row missing a dimension its grain is keyed by rather than throwing
 * the whole report away — for those, `rows.length + skipped.length` equals
 * `sourceRows` exactly, and the fetch handler asserts it.
 *
 * Keeping all three means the fetch handler can assert fact rows offered
 * against fact rows written (the invariant the ledger records) without losing
 * the number an operator compares to the Amazon UI.
 */
export type ParsedFactBatch = { sourceRows: number; skipped: SkippedReportRow[] } & (
  | { kind: 'sp_target'; rows: NewSpTargetFact[] }
  | { kind: 'search_term'; rows: NewSearchTermFact[] }
  | { kind: 'placement'; rows: NewPlacementFact[] }
  | { kind: 'profile'; rows: NewProfileFact[] }
  | { kind: 'sb'; rows: CampaignFactRow[] }
  | { kind: 'sd'; rows: CampaignFactRow[] }
);

export interface DownloadedJson {
  value: unknown;
  bytesDownloaded: number;
}

export interface ReportDownloadLimits {
  /** Compressed wire bytes accepted from the pre-signed report URL. */
  maxCompressedBytes: number;
  /** Inflated JSON bytes retained before parsing. */
  maxDecompressedBytes: number;
  /** Longest permitted wait between compressed chunks. */
  idleTimeoutMs: number;
  /** Complete download, inflation and JSON parsing budget. */
  totalTimeoutMs: number;
}

/**
 * Production aggregates currently remain below 300 KiB compressed. These
 * limits preserve over 100x compressed headroom and a separate decompression
 * ceiling while making the process memory bound explicit.
 */
export const DEFAULT_REPORT_DOWNLOAD_LIMITS: Readonly<ReportDownloadLimits> = Object.freeze({
  maxCompressedBytes: 32 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 15 * 60_000,
});

export type ReportDownloadLimitKind =
  | 'compressed_bytes'
  | 'decompressed_bytes'
  | 'idle_timeout'
  | 'total_timeout';

/** Fixed-category limit failure. Source chunks and provider details are never retained. */
export class ReportDownloadLimitError extends Error {
  override readonly name = 'ReportDownloadLimitError';

  constructor(readonly kind: ReportDownloadLimitKind, readonly limit: number) {
    super(`report download exceeded ${kind} limit`);
  }
}

/**
 * Stream compressed bytes through gunzip under explicit byte and time bounds.
 * Only the bounded inflated JSON document is retained.
 */
export async function gunzipJson(
  source: AsyncIterable<Uint8Array>,
  limits: Readonly<ReportDownloadLimits> = DEFAULT_REPORT_DOWNLOAD_LIMITS,
  signal?: AbortSignal,
): Promise<DownloadedJson> {
  assertDownloadLimits(limits);
  const startedAt = Date.now();
  let bytesDownloaded = 0;
  const controller = new AbortController();
  const totalError = new ReportDownloadLimitError('total_timeout', limits.totalTimeoutMs);
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const totalTimer = setTimeout(() => controller.abort(totalError), limits.totalTimeoutMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;

  async function* measured(): AsyncGenerator<Uint8Array> {
    iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const item = await nextDownloadChunk(iterator, controller.signal, limits.idleTimeoutMs);
        if (item.done) return;
        const nextBytes = bytesDownloaded + item.value.byteLength;
        if (nextBytes > limits.maxCompressedBytes) {
          throw new ReportDownloadLimitError('compressed_bytes', limits.maxCompressedBytes);
        }
        bytesDownloaded = nextBytes;
        yield item.value;
      }
    } finally {
      if (iterator.return) void iterator.return().catch(() => undefined);
    }
  }

  const chunks: Buffer[] = [];
  let decompressedBytes = 0;
  const compressed = Readable.from(measured());
  const unzipped = createGunzip();
  compressed.once('error', (error) => unzipped.destroy(error));
  compressed.pipe(unzipped);

  const abort = (): void => {
    const reason = controller.signal.reason instanceof Error
      ? controller.signal.reason
      : totalError;
    compressed.destroy(reason);
    unzipped.destroy(reason);
  };
  controller.signal.addEventListener('abort', abort, { once: true });

  try {
    for await (const chunk of unzipped) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const nextBytes = decompressedBytes + buffer.byteLength;
      if (nextBytes > limits.maxDecompressedBytes) {
        throw new ReportDownloadLimitError(
          'decompressed_bytes',
          limits.maxDecompressedBytes,
        );
      }
      decompressedBytes = nextBytes;
      chunks.push(buffer);
    }
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw totalError;
    }
    const value = JSON.parse(
      Buffer.concat(chunks, decompressedBytes).toString('utf8'),
    ) as unknown;
    // JSON.parse is synchronous, so a timer cannot interrupt it. Check elapsed
    // time again before allowing an over-budget document into the workflow.
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw totalError;
    }
    return {
      value,
      bytesDownloaded,
    };
  } finally {
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', abort);
    compressed.destroy();
    unzipped.destroy();
    if (iterator?.return) void iterator.return().catch(() => undefined);
  }
}

function assertDownloadLimits(limits: Readonly<ReportDownloadLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

function nextDownloadChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const idleTimer = setTimeout(
      () => finish(() => reject(new ReportDownloadLimitError('idle_timeout', idleTimeoutMs))),
      idleTimeoutMs,
    );
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (item) => finish(() => resolve(item)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('report row must be an object');
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, field: string, nullable = false): string | null {
  const value = row[field];
  if (nullable && (value === null || value === undefined)) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new Error(`${field} must be a non-empty string`);
  return String(value);
}

function numberField(row: Record<string, unknown>, field: string, integer = false): number {
  const raw = row[field] ?? 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`${field} must be a non-negative${integer ? ' integer' : ''}`);
  return value;
}

function parseCommon(value: unknown): [Record<string, unknown>, CommonRow] {
  const row = record(value);
  const date = stringField(row, 'date');
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  return [row, { date, impressions: numberField(row, 'impressions', true), clicks: numberField(row, 'clicks', true), cost: numberField(row, 'cost') }];
}

function parseSpCampaign(value: unknown): SpCampaignRow {
  const [row, commonRow] = parseCommon(value);
  return { ...commonRow, campaignId: stringField(row, 'campaignId') as string, purchases7d: numberField(row, 'purchases7d', true), sales7d: numberField(row, 'sales7d'), unitsSoldClicks7d: numberField(row, 'unitsSoldClicks7d', true) };
}

function parseCampaign(value: unknown): CampaignRow {
  const row = record(value);
  return { ...parseSpCampaign(value), adGroupId: stringField(row, 'adGroupId', true) };
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('report payload must be a JSON array');
  return value;
}

export function parseReportRows(
  reportType: ReportType,
  value: unknown,
  profile: AdsProfileContext,
  reportRequestId: string,
): ParsedFactBatch {
  const raw = assertArray(value);
  const base = { orgId: profile.orgId, profileId: profile.id, reportRequestId };

  switch (reportType) {
    // `spTargeting` and `spSearchTerm` are parsed by `@wizard-ads/ads-api`,
    // which is the parser that has met the live report. Amazon sends
    // `keywordId` (not `targetId`) on the target grain and its own match-type
    // spellings (`EXACT`, `TARGETING_EXPRESSION`); a strict local parser
    // rejected every non-empty report of both types. The tenant join is all the
    // worker adds: the report knows Amazon's profile, we know our uuid.
    case 'spTargeting': {
      const result = parseSpTargetingReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'sp_target',
        rows: result.rows.map((row): NewSpTargetFact => ({
          ...row,
          topOfSearchImpressionShare: row.topOfSearchImpressionShare ?? null,
          ...base,
        })),
      };
    }
    case 'spSearchTerm': {
      const result = parseSpSearchTermReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'search_term',
        rows: result.rows.map((row): NewSearchTermFact => ({ ...row, ...base })),
      };
    }
    case 'spPlacement': {
      const result = parseSpPlacementReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'placement',
        rows: result.rows.map((row): NewPlacementFact => ({ ...row, ...base })),
      };
    }
    case 'spCampaigns': {
      // The campaign report arrives one row per campaign per day, and
      // `fact_profile_daily` is one row per profile per day. Summing here is
      // not a convenience: two campaigns on one date are two rows with the same
      // conflict target, and Postgres refuses to let one statement update the
      // same row twice. Aggregating turns that error into the number the grain
      // is supposed to hold.
      const byDate = new Map<string, Required<Pick<NewProfileFact,
        'impressions' | 'clicks' | 'cost' | 'purchases7d' | 'sales7d' | 'unitsSold7d'>>>();
      const result = parseSpCampaignReport(raw);
      for (const row of result.rows) {
        const running = byDate.get(row.date);
        if (running) {
          running.impressions += row.impressions;
          running.clicks += row.clicks;
          running.cost += row.cost;
          running.purchases7d += row.purchases7d;
          running.sales7d += row.sales7d;
          running.unitsSold7d += row.unitsSold7d;
          continue;
        }
        byDate.set(row.date, {
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSold7d,
        });
      }
      const rows = [...byDate.entries()].map(([date, totals]): NewProfileFact => ({
        ...base,
        date,
        currencyCode: profile.currencyCode,
        provisional: false,
        ...totals,
      }));
      return { sourceRows: result.input, skipped: result.skipped, kind: 'profile', rows };
    }
    case 'sbCampaigns':
    case 'sdCampaigns': {
      const rows = raw.map((item): CampaignFactRow => {
        const row = parseCampaign(item);
        return {
          ...base,
          date: row.date,
          campaignId: row.campaignId,
          adGroupId: row.adGroupId,
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSoldClicks7d,
          metrics: item as Record<string, unknown>,
        };
      });
      return { sourceRows: raw.length, skipped: [], kind: reportType === 'sbCampaigns' ? 'sb' : 'sd', rows };
    }
  }
}
