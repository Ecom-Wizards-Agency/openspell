/** Bounded, deterministic serialization for the serverless Grid response. */
import type { GridPayload } from '../../../_lib/grid-data';

/** Keep 0.5 MB of headroom below the hosting platform's documented limit. */
export const GRID_RESPONSE_BODY_BUDGET_BYTES = 4_000_000;

const ROWS_PREFIX = '{"rows":[';
const textEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function payloadSuffix(rowCount: number, truncated: boolean): string {
  return `],"rowCount":${rowCount},"truncated":${String(truncated)}}`;
}

export interface SerializedGridPayload {
  body: string;
  byteLength: number;
  payload: GridPayload;
}

/**
 * Serialize the largest contiguous row prefix that fits the raw response-body
 * budget. Rows are never skipped, and the returned count always describes the
 * body exactly. Keeping this at the HTTP boundary means the database cap and
 * the hosting limit remain independent, explicit safeguards.
 */
export function serializeGridPayloadWithinBudget(
  source: GridPayload,
  maxBytes = GRID_RESPONSE_BODY_BUDGET_BYTES,
): SerializedGridPayload {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('Grid response byte budget must be a positive safe integer');
  }
  if (source.rowCount !== source.rows.length) {
    throw new Error('Grid payload row count does not match its rows');
  }

  const serializedRows: string[] = [];
  let rowsByteLength = 0;
  const prefixByteLength = utf8Bytes(ROWS_PREFIX);

  for (const row of source.rows) {
    const serializedRow = JSON.stringify(row);
    const separatorBytes = serializedRows.length === 0 ? 0 : 1;
    const candidateCount = serializedRows.length + 1;
    const candidateIsComplete = candidateCount === source.rows.length;
    const candidateTruncated = source.truncated || !candidateIsComplete;
    const candidateRowsBytes = rowsByteLength + separatorBytes + utf8Bytes(serializedRow);
    const candidateBytes =
      prefixByteLength +
      candidateRowsBytes +
      utf8Bytes(payloadSuffix(candidateCount, candidateTruncated));

    if (candidateBytes > maxBytes) break;
    serializedRows.push(serializedRow);
    rowsByteLength = candidateRowsBytes;
  }

  const rowCount = serializedRows.length;
  const truncated = source.truncated || rowCount < source.rows.length;
  const body = `${ROWS_PREFIX}${serializedRows.join(',')}${payloadSuffix(rowCount, truncated)}`;
  const byteLength = utf8Bytes(body);
  if (byteLength > maxBytes) {
    // This can only happen when even the empty envelope exceeds a caller's
    // custom budget. Refuse the response rather than violating its hard limit.
    throw new RangeError('Grid response byte budget cannot hold the payload envelope');
  }

  return {
    body,
    byteLength,
    payload: {
      rows: source.rows.slice(0, rowCount),
      rowCount,
      truncated,
    },
  };
}
