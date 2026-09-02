import {
  enqueueRecommendationSchedulesIfReady,
  type DbHandle,
} from '@wizard-ads/db';
import type { RecommendationScheduleStore } from './recommendations-run.js';

export function createReadinessGatedRecommendationSchedules(
  handle: Pick<DbHandle, 'sql'>,
  schedules: Pick<RecommendationScheduleStore, 'enqueueDueRecommendationRuns'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Pick<RecommendationScheduleStore, 'enqueueDueRecommendationRuns'> {
  return {
    enqueueDueRecommendationRuns: (now?: Date) => enqueueRecommendationSchedulesIfReady(
      handle,
      () => schedules.enqueueDueRecommendationRuns(now),
      env,
    ),
  };
}
