import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
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
  rowsParsed: number;
  bytesDownloaded: number;
}

export type ReportRowChunkConsumer = (
  rows: readonly unknown[],
  offset: number,
) => void | Promise<void>;

export interface ReportDownloadControl {
  signal?: AbortSignal;
  /** Abort the HTTP transport synchronously when a local bound fires. */
  abortSource?: (reason: Error) => void;
  /** Consume one structurally-cloned, byte-and-row-bounded chunk at a time. */
  consumeRows: ReportRowChunkConsumer;
  /** Testable fail-closed deadline for proving iterator/transport cancellation. */
  cancellationTimeoutMs?: number;
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
  maxDecompressedBytes: 64 * 1024 * 1024,
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 15 * 60_000,
});

export type ReportDownloadLimitKind =
  | 'compressed_bytes'
  | 'decompressed_bytes'
  | 'parsed_row_bytes'
  | 'parsed_bytes'
  | 'parsed_rows'
  | 'idle_timeout'
  | 'total_timeout'
  | 'source_cancellation';

/** Fixed-category limit failure. Source chunks and provider details are never retained. */
export class ReportDownloadLimitError extends Error {
  override readonly name = 'ReportDownloadLimitError';

  constructor(readonly kind: ReportDownloadLimitKind, readonly limit: number) {
    super(`report download exceeded ${kind} limit`);
  }
}

/** The bounded parser accepted JSON, but the top-level report shape is unusable. */
export class ReportPayloadShapeError extends Error {
  override readonly name = 'ReportPayloadShapeError';

  constructor() {
    super('report payload must be a JSON array');
  }
}

const PARSED_CHUNK_MAX_ROWS = 128;
const PARSED_CHUNK_MAX_BYTES = 256 * 1024;
const PARSED_DOCUMENT_MAX_ROWS = 100_000;
const SOURCE_CANCELLATION_TIMEOUT_MS = 5_000;

/**
 * Stream compressed bytes through gunzip under explicit byte and time bounds.
 * Only the bounded inflated JSON document is retained.
 */
export async function gunzipJson(
  source: AsyncIterable<Uint8Array>,
  limits: Readonly<ReportDownloadLimits> = DEFAULT_REPORT_DOWNLOAD_LIMITS,
  control: ReportDownloadControl,
): Promise<DownloadedJson> {
  assertDownloadLimits(limits);
  const cancellationTimeoutMs = control.cancellationTimeoutMs
    ?? SOURCE_CANCELLATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(cancellationTimeoutMs) || cancellationTimeoutMs <= 0) {
    throw new RangeError('cancellationTimeoutMs must be a positive safe integer');
  }
  const startedAt = Date.now();
  let bytesDownloaded = 0;
  const controller = new AbortController();
  const totalError = new ReportDownloadLimitError('total_timeout', limits.totalTimeoutMs);
  const abortSource = (reason: Error): void => {
    control.abortSource?.(reason);
    controller.abort(reason);
  };
  const abortFromCaller = (): void => {
    const reason = control.signal?.reason instanceof Error
      ? control.signal.reason
      : totalError;
    controller.abort(reason);
  };
  if (control.signal?.aborted === true) abortFromCaller();
  else control.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const totalTimer = setTimeout(() => abortSource(totalError), limits.totalTimeoutMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let iteratorClose: Promise<void> | undefined;
  let sourceCompleted = false;

  const closeIterator = async (): Promise<void> => {
    if (sourceCompleted) return;
    if (iterator?.return === undefined) {
      throw new ReportDownloadLimitError(
        'source_cancellation',
        cancellationTimeoutMs,
      );
    }
    iteratorClose ??= Promise.resolve(iterator.return()).then((result) => {
      if (!result.done) throw new Error('source iterator did not close');
    });
    try {
      await withCancellationDeadline(iteratorClose, cancellationTimeoutMs);
    } catch (error) {
      if (error instanceof ReportDownloadLimitError) throw error;
      throw new ReportDownloadLimitError('source_cancellation', cancellationTimeoutMs);
    }
  };

  async function* measured(): AsyncGenerator<Uint8Array> {
    iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const item = await nextDownloadChunk(
          iterator,
          controller.signal,
          limits.idleTimeoutMs,
          abortSource,
        );
        if (item.done) {
          sourceCompleted = true;
          return;
        }
        const nextBytes = bytesDownloaded + item.value.byteLength;
        if (nextBytes > limits.maxCompressedBytes) {
          const error = new ReportDownloadLimitError(
            'compressed_bytes',
            limits.maxCompressedBytes,
          );
          abortSource(error);
          throw error;
        }
        bytesDownloaded = nextBytes;
        yield item.value;
      }
    } finally {
      await closeIterator();
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
        const error = new ReportDownloadLimitError(
          'decompressed_bytes',
          limits.maxDecompressedBytes,
        );
        abortSource(error);
        throw error;
      }
      decompressedBytes = nextBytes;
      chunks.push(buffer);
    }
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw totalError;
    }
    const rowsParsed = await parseJsonInWorker(
      Buffer.concat(chunks, decompressedBytes),
      controller.signal,
      limits.maxDecompressedBytes,
      control.consumeRows,
    );
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw totalError;
    }
    return {
      rowsParsed,
      bytesDownloaded,
    };
  } finally {
    clearTimeout(totalTimer);
    control.signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', abort);
    compressed.destroy();
    unzipped.destroy();
    await closeIterator();
  }
}

/**
 * Parse away from the queue-custody event loop. The worker has an explicit
 * heap ceiling and is terminated before this promise settles, so both the
 * total deadline and a memory-hostile document have a real kill boundary.
 */
function parseJsonInWorker(
  bytes: Buffer,
  signal: AbortSignal,
  memoryLimit: number,
  consumeRows: ReportRowChunkConsumer,
): Promise<number> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./report-json-parser-worker.mjs', import.meta.url), {
      resourceLimits: {
        maxOldGenerationSizeMb: 192,
        maxYoungGenerationSizeMb: 32,
      },
    });
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      void worker.terminate().then(callback, callback);
    };
    const onAbort = (): void => finish(() => reject(signal.reason));

    signal.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message: unknown) => {
      if (settled || typeof message !== 'object' || message === null || !('kind' in message)) {
        finish(() => reject(new Error('report payload is not valid JSON')));
        return;
      }
      if (message.kind === 'rows' && 'rows' in message && 'offset' in message
        && Array.isArray(message.rows) && Number.isSafeInteger(message.offset)) {
        void Promise.resolve(consumeRows(message.rows, Number(message.offset))).then(
          () => {
            if (!settled) worker.postMessage({ kind: 'next' });
          },
          (error: unknown) => finish(() => reject(error)),
        );
        return;
      }
      if (message.kind === 'done' && 'rowCount' in message
        && Number.isSafeInteger(message.rowCount) && Number(message.rowCount) >= 0) {
        finish(() => resolve(Number(message.rowCount)));
        return;
      }
      if (message.kind === 'not_array') {
        finish(() => reject(new ReportPayloadShapeError()));
        return;
      }
      if (message.kind === 'row_limit') {
        finish(() => reject(new ReportDownloadLimitError(
          'parsed_row_bytes',
          PARSED_CHUNK_MAX_BYTES,
        )));
        return;
      }
      if (message.kind === 'row_count_limit') {
        finish(() => reject(new ReportDownloadLimitError(
          'parsed_rows',
          PARSED_DOCUMENT_MAX_ROWS,
        )));
        return;
      }
      finish(() => reject(new Error('report payload is not valid JSON')));
    });
    worker.once('error', () => {
      finish(() => reject(new ReportDownloadLimitError('decompressed_bytes', memoryLimit)));
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        finish(() => reject(new ReportDownloadLimitError('decompressed_bytes', memoryLimit)));
      }
    });
    const transferable = new Uint8Array(bytes.byteLength);
    transferable.set(bytes);
    worker.postMessage({
      kind: 'start',
      bytes: transferable.buffer,
      maxRows: PARSED_CHUNK_MAX_ROWS,
      maxBytes: PARSED_CHUNK_MAX_BYTES,
      maxTotalRows: PARSED_DOCUMENT_MAX_ROWS,
    }, [transferable.buffer]);
  });
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
  abortSource: (reason: Error) => void,
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
    const idleTimer = setTimeout(() => {
      const error = new ReportDownloadLimitError('idle_timeout', idleTimeoutMs);
      abortSource(error);
      finish(() => reject(error));
    }, idleTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (item) => finish(() => resolve(item)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function withCancellationDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<void>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ReportDownloadLimitError(
        'source_cancellation',
        timeoutMs,
      )), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
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

/**
 * Merge one bounded parser chunk into report-wide normalized facts. Raw provider
 * rows are never retained in the parent process. Refusal indexes are shifted to
 * their report-wide positions so accounting remains exact.
 */
export function mergeParsedFactBatches(
  current: ParsedFactBatch | undefined,
  next: ParsedFactBatch,
  sourceOffset: number,
): ParsedFactBatch {
  const skipped = next.skipped.map((row) => ({ ...row, index: row.index + sourceOffset }));
  if (current === undefined) return { ...next, skipped };
  if (current.kind !== next.kind) throw new Error('report parser chunk kind changed');
  current.sourceRows += next.sourceRows;
  current.skipped.push(...skipped);

  switch (current.kind) {
    case 'sp_target': {
      if (next.kind !== 'sp_target') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'search_term': {
      if (next.kind !== 'search_term') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'placement': {
      if (next.kind !== 'placement') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'profile': {
      if (next.kind !== 'profile') throw new Error('report parser chunk kind changed');
      const byDate = new Map(current.rows.map((row) => [row.date, { ...row }]));
      for (const row of next.rows) {
        const existing = byDate.get(row.date);
        if (!existing) {
          byDate.set(row.date, { ...row });
          continue;
        }
        existing.impressions = (existing.impressions ?? 0) + (row.impressions ?? 0);
        existing.clicks = (existing.clicks ?? 0) + (row.clicks ?? 0);
        existing.cost = (existing.cost ?? 0) + (row.cost ?? 0);
        existing.purchases7d = (existing.purchases7d ?? 0) + (row.purchases7d ?? 0);
        existing.sales7d = (existing.sales7d ?? 0) + (row.sales7d ?? 0);
        existing.unitsSold7d = (existing.unitsSold7d ?? 0) + (row.unitsSold7d ?? 0);
      }
      current.rows.splice(0, current.rows.length, ...byDate.values());
      return current;
    }
    case 'sb': {
      if (next.kind !== 'sb') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'sd': {
      if (next.kind !== 'sd') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
  }
}
