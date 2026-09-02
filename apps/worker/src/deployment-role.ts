import { Uuid, type JobType } from '@wizard-ads/shared';

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

/** The report lane may claim this expanded set only while WP-181 is explicitly enabled. */
export const UNIFIED_EVO_REPORT_LANE_JOB_TYPES = [
  ...EVO_REPORT_LANE_JOB_TYPES,
  'report.unified.advance',
] as const satisfies readonly JobType[];

export const CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV =
  'OPENSPELL_CREATIVE_SYNC_PROFILE_ALLOWLIST' as const;

export const UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV =
  'OPENSPELL_UNIFIED_REPORTING_PROFILE_ALLOWLIST' as const;
export const MAX_UNIFIED_REPORTING_PROFILE_IDS = 10;

export type WorkerDeploymentRole = 'general' | 'evo-report-lane';
export type WorkerClaimProtocol = 'legacy' | 'fenced';

export interface WorkerDeploymentPolicy {
  role: WorkerDeploymentRole;
  claimProtocol: WorkerClaimProtocol;
  /** The effective claim policy. Undefined retains the general all-queue mode. */
  jobTypes: readonly JobType[] | undefined;
  /** The exclusive report runtime is a queue consumer, not a timer host. */
  startsBackgroundPasses: boolean;
}

export type CreativeSyncPilotPolicy =
  | { enabled: false; profileIds: readonly [] }
  | { enabled: true; profileIds: readonly string[] };

export type UnifiedReportingDualRunPolicy =
  | { enabled: false; profileIds: readonly [] }
  | { enabled: true; profileIds: readonly string[] };

/**
 * Parse the deployment-only pilot cohort without ever rendering an identifier
 * in an error. An allowlist is a safety boundary, so duplicates are rejected
 * rather than silently normalized away.
 */
export function parseCreativeSyncProfileAllowlist(value: string | undefined): readonly string[] {
  return parseProfileAllowlist(value, CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV);
}

export function parseUnifiedReportingProfileAllowlist(
  value: string | undefined,
): readonly string[] {
  return parseProfileAllowlist(
    value,
    UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV,
    MAX_UNIFIED_REPORTING_PROFILE_IDS,
  );
}

/**
 * Source stays inert unless the producer, exclusive report lane, and a
 * non-empty bounded cohort all agree. Values unrelated to the disabled
 * producer are deliberately ignored so an absent/zero gate performs no work.
 */
export function resolveCreativeSyncPilotPolicy(
  env: Readonly<Record<string, string | undefined>>,
): CreativeSyncPilotPolicy {
  const producer = env['OPENSPELL_CREATIVE_SYNC_PRODUCER_READY'];
  if (producer === undefined || producer === '0') return { enabled: false, profileIds: [] };
  if (producer !== '1') {
    throw new Error('OPENSPELL_CREATIVE_SYNC_PRODUCER_READY must be 0 or 1');
  }
  if (env['OPENSPELL_EVO_REPORT_LANE_READY'] !== '1') {
    throw new Error('Creative sync producer requires the exclusive Evo report lane');
  }
  return {
    enabled: true,
    profileIds: parseCreativeSyncProfileAllowlist(env[CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV]),
  };
}

/**
 * Resolve the worker's role after WORKER_JOB_TYPES has been parsed. The report
 * role deliberately does not infer its allowlist: the deployment must state
 * the exact ownership contract, and a partial or foreign list fails startup.
 */
export function resolveWorkerDeploymentPolicy(
  roleValue: string | undefined,
  configuredJobTypes: readonly JobType[] | undefined,
  unifiedReportingEnabled = false,
): WorkerDeploymentPolicy {
  if (roleValue === undefined || roleValue === 'general') {
    return {
      role: 'general',
      claimProtocol: 'legacy',
      jobTypes: configuredJobTypes,
      startsBackgroundPasses: true,
    };
  }
  if (roleValue !== 'evo-report-lane') {
    throw new Error('WORKER_DEPLOYMENT_ROLE must be general or evo-report-lane');
  }
  const expected = unifiedReportingEnabled
    ? UNIFIED_EVO_REPORT_LANE_JOB_TYPES
    : EVO_REPORT_LANE_JOB_TYPES;
  if (!sameSet(configuredJobTypes, expected)) {
    throw new Error(
      `WORKER_JOB_TYPES must exactly match the ${expected.length}-type Evo report lane`,
    );
  }
  return {
    role: 'evo-report-lane',
    claimProtocol: 'fenced',
    jobTypes: expected,
    startsBackgroundPasses: false,
  };
}

/**
 * WP-181 stays fully inert until the source gate, exclusive deployment, exact
 * expanded claim set, and bounded cohort all agree. Disabled source ignores a
 * stale allowlist so rolling back the gate does not make startup depend on it.
 */
export function resolveUnifiedReportingDualRunPolicy(
  env: Readonly<Record<string, string | undefined>>,
  deployment: WorkerDeploymentPolicy,
): UnifiedReportingDualRunPolicy {
  const ready = env['OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY'];
  if (ready === undefined || ready === '0') return { enabled: false, profileIds: [] };
  if (ready !== '1') {
    throw new Error('OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY must be 0 or 1');
  }
  if (env['OPENSPELL_EVO_REPORT_LANE_READY'] !== '1') {
    throw new Error('Unified Reporting dual run requires the exclusive Evo report lane');
  }
  if (
    deployment.role !== 'evo-report-lane' ||
    !sameSet(deployment.jobTypes, UNIFIED_EVO_REPORT_LANE_JOB_TYPES)
  ) {
    throw new Error('Unified Reporting dual run requires the exact expanded Evo claim set');
  }
  return {
    enabled: true,
    profileIds: parseUnifiedReportingProfileAllowlist(
      env[UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV],
    ),
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

function parseProfileAllowlist(
  value: string | undefined,
  envName: string,
  maximum?: number,
): readonly string[] {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${envName} must contain at least one profile UUID`);
  }
  const tokens = value.split(',').map((token) => token.trim().toLowerCase());
  if (maximum !== undefined && tokens.length > maximum) {
    throw new Error(`${envName} must contain at most ${maximum} profile UUIDs`);
  }
  if (tokens.some((token) => token.length === 0 || !Uuid.safeParse(token).success)) {
    throw new Error(`${envName} must be a comma-separated UUID list`);
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error(`${envName} must not contain duplicate UUIDs`);
  }
  return tokens;
}
