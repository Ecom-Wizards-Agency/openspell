/** Fixed, identifier-free Grid stages accepted by the release verifier. */
export const RELEASE_GRID_TIMING_SPANS = [
  'actor',
  'role',
  'profile',
  'rows',
  'serialize',
  'close',
  'total',
] as const;

export type ReleaseGridTimingSpan = (typeof RELEASE_GRID_TIMING_SPANS)[number];
export type GridServerTimingDurations = Record<ReleaseGridTimingSpan, number>;

export function isCompleteGridRowsEvidence(input: {
  status: number | null;
  rowCount: number | null;
  returnedRows: number | null;
  truncated: boolean | null;
  serverTiming: GridServerTimingDurations | null;
}): boolean {
  return input.status === 200
    && input.rowCount !== null
    && input.rowCount === input.returnedRows
    && input.truncated === false
    && input.serverTiming !== null;
}

/**
 * Accept only the exact closed timing grammar emitted by the Grid rows route.
 *
 * Vercel and curl may expose many response headers. The verifier retains none
 * of them: only seven ordered names and finite non-negative durations survive
 * this boundary, so cookies, tenant identity and arbitrary metadata cannot
 * enter the public release report.
 */
export function parseGridServerTiming(value: string): GridServerTimingDurations | null {
  const parts = value.split(', ');
  if (parts.length !== RELEASE_GRID_TIMING_SPANS.length) return null;

  const durations = {} as GridServerTimingDurations;
  for (const [index, name] of RELEASE_GRID_TIMING_SPANS.entries()) {
    const part = parts[index];
    if (part === undefined) return null;
    const match = new RegExp(`^${name};dur=(\\d+(?:\\.\\d+)?)$`).exec(part);
    if (match?.[1] === undefined) return null;
    const duration = Number(match[1]);
    if (!Number.isFinite(duration) || duration < 0) return null;
    durations[name] = duration;
  }
  return durations;
}
