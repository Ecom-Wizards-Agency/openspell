/**
 * The default sync cadences, as rows rather than as a comment.
 *
 * WP-03's brief: entity sync daily per enabled profile; reports daily over the
 * trailing 3 days; a weekly re-pull over the trailing 35 days. The third one is
 * the only one that needs explaining — Amazon restates sales for 14+ days after
 * the fact, so a report pulled the morning after is not the report that will be
 * true a fortnight later, and the slow re-pull is what makes the facts converge
 * on the truth instead of freezing the first guess.
 *
 * Two schedules per report type for one profile is exactly what the original
 * `sync_schedules` uniqueness key forbade; `variant` (migration
 * 20260814140000) is what makes the pair representable.
 *
 * `next_run_at` is left at its default of `now()`, so provisioning a profile
 * enqueues its first pass on the next five-minute cron tick rather than a day
 * later.
 */
import type { ReportType } from '@wizard-ads/shared';

export type ScheduleVariant = 'default' | 'restatement';

export interface ScheduleSpec {
  jobType: 'entity.sync' | 'report.request';
  reportType: ReportType | null;
  variant: ScheduleVariant;
  cadence: string;
  lookbackDays: number | null;
  payload: Record<string, unknown>;
}

/** The report types v1 pulls. One `report.request` schedule pair each. */
export const DEFAULT_REPORT_TYPES: readonly ReportType[] = [
  'spCampaigns',
  'spTargeting',
  'spSearchTerm',
  'spPlacement',
  'sbCampaigns',
  'sdCampaigns',
];

export const DEFAULT_CADENCES = {
  /** A full entity pass: it re-lists everything, so absence means deleted. */
  entity: { cadence: '1 day', full: true },
  /** Yesterday plus the two before it, in the profile's own calendar. */
  reportRecent: { cadence: '1 day', lookbackDays: 3 },
  /** Long enough to cover the 14+ day restatement window twice over. */
  reportRestatement: { cadence: '7 days', lookbackDays: 35 },
} as const;

export function defaultSchedules(
  reportTypes: readonly ReportType[] = DEFAULT_REPORT_TYPES,
): ScheduleSpec[] {
  const specs: ScheduleSpec[] = [
    {
      jobType: 'entity.sync',
      reportType: null,
      variant: 'default',
      cadence: DEFAULT_CADENCES.entity.cadence,
      lookbackDays: null,
      payload: { full: DEFAULT_CADENCES.entity.full },
    },
  ];
  for (const reportType of reportTypes) {
    specs.push({
      jobType: 'report.request',
      reportType,
      variant: 'default',
      cadence: DEFAULT_CADENCES.reportRecent.cadence,
      lookbackDays: DEFAULT_CADENCES.reportRecent.lookbackDays,
      payload: {},
    });
    specs.push({
      jobType: 'report.request',
      reportType,
      variant: 'restatement',
      cadence: DEFAULT_CADENCES.reportRestatement.cadence,
      lookbackDays: DEFAULT_CADENCES.reportRestatement.lookbackDays,
      payload: {},
    });
  }
  return specs;
}
