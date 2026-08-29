/**
 * Opt-in server-side loader diagnostics.
 *
 * The event deliberately accepts only a closed span name plus numeric output
 * dimensions. Query inputs, tenant identifiers, labels, and error messages can
 * therefore never cross this logging boundary.
 */

export const SERVER_TIMING_SPANS = [
  'grid.campaigns',
  'grid.ad_groups',
  'grid.targets',
  'grid.search_terms',
  'grid.placements',
  'optimizer.runs',
  'optimizer.workspace',
  'optimizer.account_rows',
  'optimizer.report_ledger',
  'optimizer.campaign_facts',
  'optimizer.requested_run',
  'optimizer.latest_run_snapshot',
  'optimizer.latest_run_detail',
  'optimizer.recommendations',
] as const;

export type ServerTimingSpan = (typeof SERVER_TIMING_SPANS)[number];

const DIAGNOSTICS_ENV = 'WIZARD_ADS_PERF_DIAGNOSTICS';

interface CompletedTimingEvent {
  event: 'openspell.server_timing';
  span: ServerTimingSpan;
  status: 'ok';
  duration_ms: number;
  row_count: number | null;
  serialized_bytes: number | null;
}

interface FailedTimingEvent {
  event: 'openspell.server_timing';
  span: ServerTimingSpan;
  status: 'error';
  duration_ms: number;
}

/**
 * Time a server-only loader without changing its result or error behavior.
 * Diagnostics default off, avoiding JSON serialization work on normal requests.
 */
export async function withServerTiming<T>(
  span: ServerTimingSpan,
  load: () => Promise<T>,
  rowCountOf: (value: T) => number,
): Promise<T> {
  if (process.env[DIAGNOSTICS_ENV] !== '1') return load();

  const startedAt = performance.now();
  try {
    const value = await load();
    const event: CompletedTimingEvent = {
      event: 'openspell.server_timing',
      span,
      status: 'ok',
      duration_ms: elapsedMilliseconds(startedAt),
      row_count: safeRowCount(rowCountOf, value),
      serialized_bytes: serializedByteLength(value),
    };
    console.info(JSON.stringify(event));
    return value;
  } catch (error) {
    const event: FailedTimingEvent = {
      event: 'openspell.server_timing',
      span,
      status: 'error',
      duration_ms: elapsedMilliseconds(startedAt),
    };
    console.info(JSON.stringify(event));
    throw error;
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
}

function safeRowCount<T>(rowCountOf: (value: T) => number, value: T): number | null {
  try {
    const count = rowCountOf(value);
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null;
  } catch {
    return null;
  }
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return 0;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}
