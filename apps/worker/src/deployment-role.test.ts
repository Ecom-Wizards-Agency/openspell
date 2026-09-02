import { describe, expect, it } from 'vitest';
import {
  CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV,
  DEFAULT_VERCEL_CRON_JOB_TYPES,
  EVO_REPORT_LANE_JOB_TYPES,
  MAX_UNIFIED_REPORTING_PROFILE_IDS,
  UNIFIED_EVO_REPORT_LANE_JOB_TYPES,
  UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV,
  REDUCED_VERCEL_CRON_JOB_TYPES,
  parseCreativeSyncProfileAllowlist,
  resolveCreativeSyncPilotPolicy,
  resolveUnifiedReportingDualRunPolicy,
  resolveWorkerDeploymentPolicy,
  vercelCronJobTypesFromEnv,
} from './deployment-role.js';

const PROFILE_ONE = '11111111-2222-4333-8444-555555555555';
const PROFILE_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa';

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
      role: 'general', claimProtocol: 'legacy', jobTypes: undefined, startsBackgroundPasses: true,
    });
    expect(resolveWorkerDeploymentPolicy('general', ['rank.sync'])).toEqual({
      role: 'general', claimProtocol: 'legacy', jobTypes: ['rank.sync'], startsBackgroundPasses: true,
    });
  });

  it('canonicalizes the exact Evo report set and disables all background passes', () => {
    expect(resolveWorkerDeploymentPolicy('evo-report-lane', [
      'report.fetch', 'creative.sync', 'report.poll', 'report.request',
    ])).toEqual({
      role: 'evo-report-lane',
      claimProtocol: 'fenced',
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

describe('bounded Creative producer cohort', () => {
  it('keeps an absent or zero producer fully inert without inspecting the cohort', () => {
    expect(resolveCreativeSyncPilotPolicy({})).toEqual({ enabled: false, profileIds: [] });
    expect(resolveCreativeSyncPilotPolicy({
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '0',
      [CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV]: 'not-a-uuid',
    })).toEqual({ enabled: false, profileIds: [] });
  });

  it('requires the exclusive lane and a non-empty canonical cohort when enabled', () => {
    expect(resolveCreativeSyncPilotPolicy({
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      [CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV]: ` ${PROFILE_ONE.toUpperCase()},${PROFILE_TWO} `,
    })).toEqual({ enabled: true, profileIds: [PROFILE_ONE, PROFILE_TWO] });
    expect(() => resolveCreativeSyncPilotPolicy({
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '0',
      [CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV]: PROFILE_ONE,
    })).toThrow(/exclusive Evo report lane/);
    expect(() => resolveCreativeSyncPilotPolicy({
      OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
    })).toThrow(new RegExp(CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV));
  });

  it('rejects malformed, empty-token, and duplicate cohorts without echoing identifiers', () => {
    const malformed = 'not-a-profile-id';
    for (const value of ['', malformed, `${PROFILE_ONE},`, `${PROFILE_ONE},${PROFILE_ONE.toUpperCase()}`]) {
      let message = '';
      try {
        parseCreativeSyncProfileAllowlist(value);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV);
      expect(message).not.toContain(malformed);
      expect(message).not.toContain(PROFILE_ONE);
    }
  });
});

describe('bounded Unified Reporting dual run', () => {
  it('keeps absent and zero gates inert without inspecting deployment values', () => {
    expect(resolveUnifiedReportingDualRunPolicy({}, {
      role: 'general', claimProtocol: 'legacy', jobTypes: undefined, startsBackgroundPasses: true,
    })).toEqual({ enabled: false, profileIds: [] });
    expect(resolveUnifiedReportingDualRunPolicy({
      OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '0',
      [UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV]: 'not-a-uuid',
    }, {
      role: 'general', claimProtocol: 'legacy', jobTypes: undefined, startsBackgroundPasses: true,
    })).toEqual({ enabled: false, profileIds: [] });
  });

  it('fails the five-type lane closed under fenced custody', () => {
    expect(() => resolveUnifiedReportingDualRunPolicy({
      OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '0',
      [UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV]: PROFILE_ONE,
    }, resolveWorkerDeploymentPolicy(
      'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES,
    ))).toThrow(/exclusive Evo report lane/);

    expect(() => resolveUnifiedReportingDualRunPolicy({
      OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      [UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV]: PROFILE_ONE,
    }, resolveWorkerDeploymentPolicy(
      'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES,
    ))).toThrow(/incompatible with fenced report custody/);
  });

  it('accepts no fenced policy beyond the exact four-type database lane', () => {
    const accepted = resolveWorkerDeploymentPolicy(
      'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES,
    );
    expect(accepted.jobTypes).toBe(EVO_REPORT_LANE_JOB_TYPES);
    expect(() => resolveWorkerDeploymentPolicy(
      'evo-report-lane', UNIFIED_EVO_REPORT_LANE_JOB_TYPES,
    )).toThrow(/4-type Evo report lane/);
    expect(() => resolveWorkerDeploymentPolicy(
      'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES, true,
    )).toThrow(/incompatible with fenced report custody/);
  });

  it('does not inspect or echo a cohort when the fenced lane is incompatible', () => {
    const oversized = Array.from(
      { length: MAX_UNIFIED_REPORTING_PROFILE_IDS + 1 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    ).join(',');
    expect(() => resolveUnifiedReportingDualRunPolicy({
      OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '1',
      OPENSPELL_EVO_REPORT_LANE_READY: '1',
      [UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV]: oversized,
    }, resolveWorkerDeploymentPolicy(
      'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES,
    ))).toThrow(/incompatible with fenced report custody/);
    try {
      resolveUnifiedReportingDualRunPolicy({
        OPENSPELL_UNIFIED_REPORTING_DUAL_RUN_READY: '1',
        OPENSPELL_EVO_REPORT_LANE_READY: '1',
        [UNIFIED_REPORTING_PROFILE_ALLOWLIST_ENV]: oversized,
      }, resolveWorkerDeploymentPolicy(
        'evo-report-lane', EVO_REPORT_LANE_JOB_TYPES,
      ));
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(
        '00000000-0000-4000-8000-000000000011',
      );
    }
  });
});
