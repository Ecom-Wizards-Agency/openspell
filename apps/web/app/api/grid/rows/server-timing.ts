/** Closed, identifier-free timing evidence for the authenticated Grid route. */

export const GRID_SERVER_TIMING_SPANS = [
  'actor',
  'role',
  'profile',
  'rows',
  'serialize',
  'close',
] as const;

export type GridServerTimingSpan = (typeof GRID_SERVER_TIMING_SPANS)[number];

interface CompletedSpan {
  name: GridServerTimingSpan;
  durationMs: number;
}

function duration(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/**
 * Measure only fixed route stages. Callers cannot attach profile ids, labels,
 * query text, or error details because the API accepts no metadata.
 */
export class GridServerTiming {
  private readonly startedAt: number;
  private cursor: number;
  private readonly spans: CompletedSpan[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
    this.cursor = this.startedAt;
  }

  mark(name: GridServerTimingSpan): void {
    const completedAt = this.now();
    this.spans.push({ name, durationMs: duration(completedAt - this.cursor) });
    this.cursor = completedAt;
  }

  header(): string {
    const totalMs = duration(this.now() - this.startedAt);
    return [
      ...this.spans.map((span) => `${span.name};dur=${span.durationMs.toFixed(2)}`),
      `total;dur=${totalMs.toFixed(2)}`,
    ].join(', ');
  }
}

/** Await database teardown before exposing the complete client-visible success timing. */
export async function finalizeTimedGridResponse(
  response: Response,
  timing: GridServerTiming,
  close: () => Promise<void>,
): Promise<void> {
  await close();
  timing.mark('close');
  response.headers.set('Server-Timing', timing.header());
}
