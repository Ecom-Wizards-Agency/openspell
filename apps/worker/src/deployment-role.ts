import type { JobType } from '@wizard-ads/shared';

/**
 * The queue types Vercel owns until the report-lane handoff is explicitly
 * activated. Keep this list stable so a source deploy alone cannot strand
 * reporting work.
 */
export const DEFAULT_VERCEL_CRON_JOB_TYPES = [
  'entity.sync',
  'report.request',
  'report.poll',
  'report.fetch',
  'recommendations.run',
] as const satisfies readonly JobType[];

/** Queue types Vercel retains after the report lane is active on Evo. */
export const REDUCED_VERCEL_CRON_JOB_TYPES = [
  'entity.sync',
  'recommendations.run',
] as const satisfies readonly JobType[];

/** The complete and exclusive queue surface of the Evo report runtime. */
export const EVO_REPORT_LANE_JOB_TYPES = [
  'creative.sync',
  'report.request',
  'report.poll',
  'report.fetch',
] as const satisfies readonly JobType[];

export type WorkerDeploymentRole = 'general' | 'evo-report-lane';

export interface WorkerDeploymentPolicy {
  role: WorkerDeploymentRole;
  /** The effective claim policy. Undefined retains the general all-queue mode. */
  jobTypes: readonly JobType[] | undefined;
  /** The exclusive report runtime is a queue consumer, not a timer host. */
  startsBackgroundPasses: boolean;
}

/**
 * Resolve the worker's role after WORKER_JOB_TYPES has been parsed. The report
 * role deliberately does not infer its allowlist: the deployment must state
 * the exact ownership contract, and a partial or foreign list fails startup.
 */
export function resolveWorkerDeploymentPolicy(
  roleValue: string | undefined,
  configuredJobTypes: readonly JobType[] | undefined,
): WorkerDeploymentPolicy {
  if (roleValue === undefined || roleValue === 'general') {
    return { role: 'general', jobTypes: configuredJobTypes, startsBackgroundPasses: true };
  }
  if (roleValue !== 'evo-report-lane') {
    throw new Error('WORKER_DEPLOYMENT_ROLE must be general or evo-report-lane');
  }
  if (!sameSet(configuredJobTypes, EVO_REPORT_LANE_JOB_TYPES)) {
    throw new Error(
      `WORKER_JOB_TYPES must exactly match the ${EVO_REPORT_LANE_JOB_TYPES.length}-type Evo report lane`,
    );
  }
  return {
    role: 'evo-report-lane',
    jobTypes: EVO_REPORT_LANE_JOB_TYPES,
    startsBackgroundPasses: false,
  };
}

/**
 * Source deployment is compatible by default. Only the exact value `1`
 * transfers report claims away from Vercel; malformed values fail closed.
 */
export function vercelCronJobTypesFromEnv(
  value: string | undefined,
): typeof DEFAULT_VERCEL_CRON_JOB_TYPES | typeof REDUCED_VERCEL_CRON_JOB_TYPES {
  if (value === undefined || value === '0') return DEFAULT_VERCEL_CRON_JOB_TYPES;
  if (value === '1') return REDUCED_VERCEL_CRON_JOB_TYPES;
  throw new Error('OPENSPELL_EVO_REPORT_LANE_READY must be 0 or 1');
}

function sameSet(left: readonly JobType[] | undefined, right: readonly JobType[]): boolean {
  if (left === undefined || left.length !== right.length) return false;
  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((jobType) => leftSet.has(jobType));
}
