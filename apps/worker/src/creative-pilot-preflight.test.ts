import { describe, expect, it } from 'vitest';
import type { CreativePilotDatabasePreflight } from '@wizard-ads/db';
import {
  evaluateCreativePilotPreflight,
  parseCreativePilotWorkerHealth,
} from './creative-pilot-preflight.js';
import { parseCreativePilotPreflightArgs } from './creative-pilot-preflight-cli.js';

const REVISION = 'abcdef1234567';
const CLAIMS = ['creative.sync', 'report.request', 'report.poll', 'report.fetch'] as const;
const UNIFIED_CLAIMS = [...CLAIMS, 'report.unified.advance'] as const;

describe('Creative pilot worker health', () => {
  it('accepts only sanitized exact deployment metadata', () => {
    expect(parseCreativePilotWorkerHealth({
      status: 'ok',
      worker: { stopping: false, running: 2 },
      deployment: {
        revision: REVISION,
        role: 'evo-report-lane',
        claimProtocol: 'fenced',
        jobTypes: CLAIMS,
      },
    })).toEqual({
      status: 'ok',
      worker: { stopping: false, running: 2 },
      deployment: {
        revision: REVISION,
        role: 'evo-report-lane',
        claimProtocol: 'fenced',
        jobTypes: CLAIMS,
      },
    });
  });

  it.each([
    null,
    { status: 'ok', worker: { stopping: false, running: 0 }, deployment: {
      revision: 'unknown', role: 'evo-report-lane', jobTypes: CLAIMS,
    } },
    { status: 'ok', worker: { stopping: false, running: 0 }, deployment: {
      revision: REVISION, role: 'evo-report-lane', jobTypes: ['creative.sync', 'creative.sync'],
    } },
    { status: 'ok', worker: { stopping: false, running: -1 }, deployment: {
      revision: REVISION, role: 'evo-report-lane', jobTypes: CLAIMS,
    } },
  ])('refuses malformed or identifier-bearing health metadata', (value) => {
    expect(() => parseCreativePilotWorkerHealth(value)).toThrow('worker health is malformed');
  });
});

describe('Creative pilot readiness', () => {
  it('passes only a complete enabled cohort on the exact healthy worker', () => {
    const result = evaluateCreativePilotPreflight(databaseEvidence(), {
      status: 'ok',
      worker: { stopping: false, running: 0 },
      deployment: {
        revision: REVISION,
        role: 'evo-report-lane',
        claimProtocol: 'fenced',
        jobTypes: CLAIMS,
      },
    }, REVISION);
    expect(result).toMatchObject({
      ready: true,
      worker: {
        passed: true,
        revisionMatches: true,
        roleMatches: true,
        protocolMatches: true,
        claimSetMatches: true,
      },
      amazonApiCalls: 0,
      amazonWriteCalls: 0,
      migrationsApplied: 0,
    });
  });

  it('rejects the five-type lane as incompatible with fenced database custody', () => {
    const result = evaluateCreativePilotPreflight(databaseEvidence(), {
      status: 'ok',
      worker: { stopping: false, running: 0 },
      deployment: {
        revision: REVISION,
        role: 'evo-report-lane',
        claimProtocol: 'fenced',
        jobTypes: UNIFIED_CLAIMS,
      },
    }, REVISION);
    expect(result.ready).toBe(false);
    expect(result.worker.claimSetMatches).toBe(false);
  });

  it.each([
    { expectedRevision: '7654321fedcba', role: 'evo-report-lane' as const, protocol: 'fenced' as const, claims: CLAIMS, pending: 0 },
    { expectedRevision: REVISION, role: 'general' as const, protocol: 'fenced' as const, claims: CLAIMS, pending: 0 },
    { expectedRevision: REVISION, role: 'evo-report-lane' as const, protocol: 'legacy' as const, claims: CLAIMS, pending: 0 },
    { expectedRevision: REVISION, role: 'evo-report-lane' as const, protocol: 'fenced' as const, claims: ['creative.sync'] as const, pending: 0 },
    { expectedRevision: REVISION, role: 'evo-report-lane' as const, protocol: 'fenced' as const, claims: CLAIMS, pending: 1 },
  ])('fails closed for revision, role, claim, or cohort-pending drift', (scenario) => {
    const database = databaseEvidence();
    database.pendingSnapshots.cohort = scenario.pending;
    const result = evaluateCreativePilotPreflight(database, {
      status: 'ok',
      worker: { stopping: false, running: 0 },
      deployment: {
        revision: REVISION,
        role: scenario.role,
        claimProtocol: scenario.protocol,
        jobTypes: scenario.claims,
      },
    }, scenario.expectedRevision);
    expect(result.ready).toBe(false);
  });
});

describe('Creative pilot preflight CLI arguments', () => {
  it('requires an unauthenticated health URL and an exact Git revision', () => {
    expect(parseCreativePilotPreflightArgs([
      '--health-url', 'http://127.0.0.1:3000/healthz',
      '--expected-revision', REVISION.toUpperCase(),
    ])).toEqual({
      healthUrl: new URL('http://127.0.0.1:3000/healthz'),
      expectedRevision: REVISION,
    });
  });

  it.each([
    ['--health-url', 'ftp://example.test/healthz', '--expected-revision', REVISION],
    ['--health-url', 'https://user:pass@example.test/healthz', '--expected-revision', REVISION],
    ['--health-url', 'https://example.test/healthz?token=value', '--expected-revision', REVISION],
    ['--health-url', 'https://example.test/healthz', '--expected-revision', 'release-name'],
  ])('refuses unsafe or malformed arguments: %j', (...args) => {
    expect(() => parseCreativePilotPreflightArgs(args)).toThrow(/usage/);
  });
});

function databaseEvidence(): CreativePilotDatabasePreflight {
  return {
    schema: {
      passed: true,
      requiredTables: 7,
      verifiedTables: 7,
      requiredColumns: 100,
      verifiedColumns: 100,
      requiredEnumValues: 10,
      verifiedEnumValues: 10,
      missingTables: [],
      missingColumns: [],
      enumMismatches: [],
    },
    cohort: { requestedProfiles: 1, existingProfiles: 1, syncEnabledProfiles: 1 },
    pendingSnapshots: { cohort: 0, total: 0 },
    amazonApiCalls: 0,
    amazonWriteCalls: 0,
    migrationsApplied: 0,
  };
}
