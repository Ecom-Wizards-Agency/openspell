import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VERCEL_CRON_JOB_TYPES,
  EVO_REPORT_LANE_JOB_TYPES,
  REDUCED_VERCEL_CRON_JOB_TYPES,
  resolveWorkerDeploymentPolicy,
  vercelCronJobTypesFromEnv,
} from './deployment-role.js';

describe('queue deployment ownership', () => {
  it('preserves the complete current Vercel ownership when the handoff is absent', () => {
    expect(vercelCronJobTypesFromEnv(undefined)).toBe(DEFAULT_VERCEL_CRON_JOB_TYPES);
    expect(vercelCronJobTypesFromEnv('0')).toBe(DEFAULT_VERCEL_CRON_JOB_TYPES);
    expect(DEFAULT_VERCEL_CRON_JOB_TYPES).toEqual([
      'entity.sync',
      'report.request',
      'report.poll',
      'report.fetch',
      'recommendations.run',
    ]);
  });

  it('makes the activated Vercel and Evo ownership sets exactly disjoint', () => {
    const vercel = vercelCronJobTypesFromEnv('1');
    expect(vercel).toBe(REDUCED_VERCEL_CRON_JOB_TYPES);
    expect(vercel).toEqual(['entity.sync', 'recommendations.run']);
    expect(EVO_REPORT_LANE_JOB_TYPES).toEqual([
      'creative.sync',
      'report.request',
      'report.poll',
      'report.fetch',
    ]);
    expect(vercel.filter((jobType) => EVO_REPORT_LANE_JOB_TYPES.includes(jobType as never)))
      .toEqual([]);
    expect(new Set([...vercel, ...EVO_REPORT_LANE_JOB_TYPES]).size)
      .toBe(vercel.length + EVO_REPORT_LANE_JOB_TYPES.length);
  });

  it.each(['', 'true', 'ready', '2'])('fails closed for malformed Vercel handoff value %j', (value) => {
    expect(() => vercelCronJobTypesFromEnv(value)).toThrow(/OPENSPELL_EVO_REPORT_LANE_READY/);
  });

  it('keeps the general worker compatible with an absent or narrow allowlist', () => {
    expect(resolveWorkerDeploymentPolicy(undefined, undefined)).toEqual({
      role: 'general', jobTypes: undefined, startsBackgroundPasses: true,
    });
    expect(resolveWorkerDeploymentPolicy('general', ['rank.sync'])).toEqual({
      role: 'general', jobTypes: ['rank.sync'], startsBackgroundPasses: true,
    });
  });

  it('canonicalizes the exact Evo report set and disables all background passes', () => {
    expect(resolveWorkerDeploymentPolicy('evo-report-lane', [
      'report.fetch', 'creative.sync', 'report.poll', 'report.request',
    ])).toEqual({
      role: 'evo-report-lane',
      jobTypes: EVO_REPORT_LANE_JOB_TYPES,
      startsBackgroundPasses: false,
    });
  });

  it.each([
    undefined,
    ['report.request', 'report.poll', 'report.fetch'],
    ['creative.sync', 'report.request', 'report.poll', 'report.fetch', 'entity.sync'],
  ] as const)('refuses an absent, partial, or foreign Evo claim set: %j', (jobTypes) => {
    expect(() => resolveWorkerDeploymentPolicy('evo-report-lane', jobTypes))
      .toThrow(/must exactly match/);
  });

  it('refuses unknown and blank deployment roles', () => {
    expect(() => resolveWorkerDeploymentPolicy('', EVO_REPORT_LANE_JOB_TYPES))
      .toThrow(/WORKER_DEPLOYMENT_ROLE/);
    expect(() => resolveWorkerDeploymentPolicy('report', EVO_REPORT_LANE_JOB_TYPES))
      .toThrow(/WORKER_DEPLOYMENT_ROLE/);
  });
});
