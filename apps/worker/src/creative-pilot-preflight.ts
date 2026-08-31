import type { CreativePilotDatabasePreflight, DbHandle } from '@wizard-ads/db';
import { inspectCreativePilotDatabase } from '@wizard-ads/db';
import type { JobType } from '@wizard-ads/shared';
import { JobType as JobTypeSchema } from '@wizard-ads/shared';
import {
  EVO_REPORT_LANE_JOB_TYPES,
  UNIFIED_EVO_REPORT_LANE_JOB_TYPES,
  type WorkerDeploymentRole,
} from './deployment-role.js';

export interface CreativePilotWorkerHealth {
  status: 'ok' | 'degraded';
  worker: { stopping: boolean; running: number };
  deployment: {
    revision: string;
    role: WorkerDeploymentRole;
    jobTypes: readonly JobType[] | 'all';
  };
}

export interface CreativePilotPreflightResult {
  ready: boolean;
  database: CreativePilotDatabasePreflight;
  worker: {
    passed: boolean;
    healthy: boolean;
    revision: string;
    revisionMatches: boolean;
    role: WorkerDeploymentRole;
    roleMatches: boolean;
    jobTypes: readonly JobType[] | 'all';
    claimSetMatches: boolean;
    stopping: boolean;
    running: number;
  };
  amazonApiCalls: 0;
  amazonWriteCalls: 0;
  migrationsApplied: 0;
}

/**
 * Compose read-only database evidence with the already-running worker's
 * sanitized health document. No provider client is accepted by this API.
 */
export async function runCreativePilotPreflight(input: {
  handle: Pick<DbHandle, 'sql'>;
  profileIds: readonly string[];
  expectedRevision: string;
  workerHealth: unknown;
}): Promise<CreativePilotPreflightResult> {
  const health = parseCreativePilotWorkerHealth(input.workerHealth);
  const database = await inspectCreativePilotDatabase(input.handle, input.profileIds);
  return evaluateCreativePilotPreflight(database, health, input.expectedRevision);
}

export function evaluateCreativePilotPreflight(
  database: CreativePilotDatabasePreflight,
  health: CreativePilotWorkerHealth,
  expectedRevision: string,
): CreativePilotPreflightResult {
  const revisionMatches = health.deployment.revision === expectedRevision;
  const roleMatches = health.deployment.role === 'evo-report-lane';
  const claimSetMatches =
    sameClaimSet(health.deployment.jobTypes, EVO_REPORT_LANE_JOB_TYPES) ||
    sameClaimSet(health.deployment.jobTypes, UNIFIED_EVO_REPORT_LANE_JOB_TYPES);
  const healthy = health.status === 'ok' && !health.worker.stopping;
  const workerPassed = healthy && revisionMatches && roleMatches && claimSetMatches;
  const cohortPassed =
    database.cohort.requestedProfiles > 0 &&
    database.cohort.existingProfiles === database.cohort.requestedProfiles &&
    database.cohort.syncEnabledProfiles === database.cohort.requestedProfiles &&
    database.pendingSnapshots.cohort === 0;
  return {
    ready: database.schema.passed && cohortPassed && workerPassed,
    database,
    worker: {
      passed: workerPassed,
      healthy,
      revision: health.deployment.revision,
      revisionMatches,
      role: health.deployment.role,
      roleMatches,
      jobTypes: health.deployment.jobTypes,
      claimSetMatches,
      stopping: health.worker.stopping,
      running: health.worker.running,
    },
    amazonApiCalls: 0,
    amazonWriteCalls: 0,
    migrationsApplied: 0,
  };
}

export function parseCreativePilotWorkerHealth(value: unknown): CreativePilotWorkerHealth {
  if (typeof value !== 'object' || value === null) throw new Error('worker health is malformed');
  const body = value as Record<string, unknown>;
  const worker = body['worker'];
  const deployment = body['deployment'];
  if (
    (body['status'] !== 'ok' && body['status'] !== 'degraded') ||
    typeof worker !== 'object' || worker === null ||
    typeof deployment !== 'object' || deployment === null
  ) throw new Error('worker health is malformed');
  const workerBody = worker as Record<string, unknown>;
  const deploymentBody = deployment as Record<string, unknown>;
  const revision = deploymentBody['revision'];
  const role = deploymentBody['role'];
  const rawJobTypes = deploymentBody['jobTypes'];
  if (
    typeof workerBody['stopping'] !== 'boolean' ||
    !Number.isInteger(workerBody['running']) ||
    Number(workerBody['running']) < 0 ||
    typeof revision !== 'string' ||
    !/^[0-9a-f]{7,64}$/.test(revision) ||
    (role !== 'general' && role !== 'evo-report-lane')
  ) throw new Error('worker health is malformed');
  let jobTypes: readonly JobType[] | 'all';
  if (rawJobTypes === 'all') {
    jobTypes = 'all';
  } else if (Array.isArray(rawJobTypes)) {
    const parsed = rawJobTypes.map((jobType) => JobTypeSchema.safeParse(jobType));
    if (
      parsed.some((result) => !result.success) ||
      new Set(rawJobTypes).size !== rawJobTypes.length
    ) throw new Error('worker health is malformed');
    jobTypes = parsed.map((result) => {
      if (!result.success) throw new Error('worker health is malformed');
      return result.data;
    });
  } else {
    throw new Error('worker health is malformed');
  }
  return {
    status: body['status'],
    worker: {
      stopping: workerBody['stopping'],
      running: Number(workerBody['running']),
    },
    deployment: { revision, role, jobTypes },
  };
}

function sameClaimSet(
  actual: readonly JobType[] | 'all',
  expected: readonly JobType[],
): boolean {
  if (actual === 'all' || actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((jobType) => actualSet.has(jobType));
}
