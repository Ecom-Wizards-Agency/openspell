/** Weekly, idempotent producer for durable `sqp.request` jobs. */
import {
  listSqpScheduleScopes,
  type DbHandle,
  type SqpScheduleScope,
} from '@wizard-ads/db';
import { SqpRequestJob, type SqpRequestJob as SqpRequestJobType } from '@wizard-ads/shared';

const DAY_MS = 86_400_000;

export interface SqpJobEnqueuer {
  enqueue(payload: SqpRequestJobType, runAt: Date, dedupeKey: string): Promise<boolean>;
}

export interface WeeklySqpScheduleResult {
  scopes: number;
  scopesWithAsins: number;
  scopesWithoutAsins: number;
  refusedScopes: number;
  sourceAsinRows: number;
  uniqueAsins: number;
  duplicateAsinRows: number;
  refusedAsinRows: number;
  offeredJobs: number;
  enqueuedJobs: number;
  alreadyPresentJobs: number;
}

export interface WeeklySqpScheduleProducer {
  enqueueDueSqpRequests(): Promise<WeeklySqpScheduleResult>;
}

function profileDate(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = read('year');
  const month = read('month');
  const day = read('day');
  if (!year || !month || !day) throw new Error('could not derive profile-local calendar date');
  return `${year}-${month}-${day}`;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Most recent fully completed Sunday-Saturday period in profile-local time. */
export function completedSqpWeek(
  timezone: string,
  now: Date,
): { weekStart: string; weekEnd: string } {
  const today = new Date(`${profileDate(timezone, now)}T00:00:00.000Z`);
  const daysBackToCompletedSaturday = ((today.getUTCDay() - 6 + 7) % 7) || 7;
  const end = new Date(today.valueOf() - daysBackToCompletedSaturday * DAY_MS);
  const start = new Date(end.valueOf() - 6 * DAY_MS);
  return { weekStart: isoDate(start), weekEnd: isoDate(end) };
}

function dedupeKey(payload: SqpRequestJobType): string {
  return ['sqp.request', payload.profileId, payload.marketplaceId, payload.weekStart].join(':');
}

export class PostgresWeeklySqpScheduler implements WeeklySqpScheduleProducer {
  constructor(
    private readonly handle: Pick<DbHandle, 'sql'>,
    private readonly jobs: SqpJobEnqueuer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueueDueSqpRequests(): Promise<WeeklySqpScheduleResult> {
    const scopes = await listSqpScheduleScopes(this.handle);
    const observedAt = this.now();
    const totals: WeeklySqpScheduleResult = {
      scopes: scopes.length,
      scopesWithAsins: 0,
      scopesWithoutAsins: 0,
      refusedScopes: 0,
      sourceAsinRows: 0,
      uniqueAsins: 0,
      duplicateAsinRows: 0,
      refusedAsinRows: 0,
      offeredJobs: 0,
      enqueuedJobs: 0,
      alreadyPresentJobs: 0,
    };

    for (const scope of scopes) {
      this.countAsins(totals, scope);
      if (scope.asins.length === 0) {
        totals.scopesWithoutAsins += 1;
        continue;
      }
      let week: { weekStart: string; weekEnd: string };
      try {
        week = completedSqpWeek(scope.timezone, observedAt);
      } catch {
        totals.refusedScopes += 1;
        continue;
      }
      totals.scopesWithAsins += 1;
      const payload = SqpRequestJob.parse({
        type: 'sqp.request',
        orgId: scope.orgId,
        profileId: scope.profileId,
        marketplaceId: scope.marketplaceId,
        asins: scope.asins,
        ...week,
      });
      totals.offeredJobs += 1;
      const inserted = await this.jobs.enqueue(payload, observedAt, dedupeKey(payload));
      if (inserted) totals.enqueuedJobs += 1;
      else totals.alreadyPresentJobs += 1;
    }

    if (
      totals.scopes !== totals.scopesWithAsins + totals.scopesWithoutAsins + totals.refusedScopes ||
      totals.sourceAsinRows !==
        totals.uniqueAsins + totals.duplicateAsinRows + totals.refusedAsinRows ||
      totals.offeredJobs !== totals.enqueuedJobs + totals.alreadyPresentJobs
    ) {
      throw new Error('weekly SQP schedule counts do not reconcile');
    }
    return totals;
  }

  private countAsins(totals: WeeklySqpScheduleResult, scope: SqpScheduleScope): void {
    totals.sourceAsinRows += scope.sourceRows;
    totals.uniqueAsins += scope.asins.length;
    totals.duplicateAsinRows += scope.duplicateRows;
    totals.refusedAsinRows += scope.refusedRows;
  }
}
