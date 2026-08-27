import type { RecommendationRunSummary } from '@wizard-ads/db';

type RunChoice = Pick<RecommendationRunSummary, 'id' | 'finishedAt'>;

/**
 * An explicit valid run wins. Otherwise prefer the newest finished run so a
 * newly queued preview does not replace the last reviewable result.
 */
export function selectRecommendationRun<T extends RunChoice>(
  runs: readonly T[],
  requestedId: string | undefined,
): T | null {
  const requested = requestedId === undefined ? undefined : runs.find((run) => run.id === requestedId);
  return requested ?? runs.find((run) => run.finishedAt !== null) ?? runs[0] ?? null;
}
