import { describe, expect, it } from 'vitest';
import { TimeMachineCursor, TimeMachineNativeWrite, compareTimeMachineCursors } from './time-machine-writes.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const at = '2026-09-05T12:00:00.123456Z';
const emptyMirror = { observations: 0, pending: 0, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 };
function queued() {
  const binding = {
    planId: id('2'), planFingerprint: 'a'.repeat(64), orgId: id('5'), profileId: id('6'),
    providerScope: { amazonProfileId: 'synthetic-profile', connectionId: id('7'), region: 'NA',
      marketplaceId: 'synthetic-marketplace', currencyCode: 'USD', apiDialect: 'sp_v3' },
    direction: 'forward', expiresAt: '2026-09-05T12:15:00.000Z', counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1,
      byRoute: { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
        'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } },
  };
  return {
    execution: { operation: { executionId: id('1'), planId: id('2') }, admission: 'queued',
      receipt: { schemaVersion: 'openspell.sp-write-authorization-receipt.v1', approvalId: id('3'), approvalRequestId: id('4'),
        executionId: id('1'), generation: id('8'), approvalMode: 'manual', plan: binding, preapprovedInversePlan: null,
        boundedAuthorization: null, approvedBy: id('9'), approvedAt: at, expiresAt: binding.expiresAt,
        confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
        gateSnapshot: { environmentGate: 'enabled', environmentGateVersion: id('10'), profileGrantId: id('11'), profileGrantVersion: id('12'),
          checkedAt: at, gateSnapshotFingerprint: 'b'.repeat(64) } },
      snapshot: { status: 'queued', accounting: { approvedRows: 1, pendingDispatch: 1, refusedBeforeDispatch: 0, intentCommitted: 0,
        providerAccepted: 0, providerRejected: 0, providerAmbiguous: 0, observedRequested: 0, observedExpectedAfterAmbiguous: 0,
        observationConflict: 0, observationMissing: 0, pendingObservation: 0, providerCallsCommitted: 0, providerCallsCompleted: 0 } },
      mirror: emptyMirror, original: null, inverses: [],
    },
    actor: { kind: 'operator', userId: id('9') }, actionId: id('13'), direction: 'forward',
    change: { key: 'keyword.bid', expected: { amount: '0.9', currencyCode: 'USD' }, requested: { amount: '0.7', currencyCode: 'USD' } },
    provenance: { kind: 'apply_row', applyRowId: id('14'), changeKey: 'keyword.bid' },
    phase: 'queued', refusal: null, observation: null, mirrorReceipt: null, inverseSummaries: [],
  };
}

describe('native Time Machine contracts', () => {
  it('preserves microseconds and gives legacy/native entries a common exact ordering', () => {
    const legacy = TimeMachineCursor.parse({ observedAt: at, id: 'change:9007199254740993' });
    const native = TimeMachineCursor.parse({ observedAt: at, id: `write:${id('2')}:${id('13')}:keyword.bid` });
    expect(legacy.observedAt).toBe(at);
    expect(TimeMachineCursor.parse({ ...legacy, observedAt: '2026-09-05T12:00:00Z' }).observedAt).toBe('2026-09-05T12:00:00.000000Z');
    expect(compareTimeMachineCursors(legacy, { ...legacy, observedAt: '2026-09-05T12:00:00.123457Z' })).toBe(-1);
    expect(compareTimeMachineCursors(legacy, native)).toBe(-1);
    expect(compareTimeMachineCursors(native, native)).toBe(0);
  });

  it('rejects lossy precision, invalid dates and forged cursor identities', () => {
    const input = { observedAt: at, id: `apply:${id('2')}` };
    expect(TimeMachineCursor.safeParse(input).success).toBe(true);
    for (const observedAt of ['2026-02-30T12:00:00Z', '0000-01-01T00:00:00Z', '2026-09-05T12:00:00.1234567Z']) {
      expect(TimeMachineCursor.safeParse({ ...input, observedAt }).success).toBe(false);
    }
    for (const fake of ['change:0', 'apply:42', `write:${id('2')}:keyword.bid`, `write:${id('2')}:${id('13')}:budget`]) {
      expect(TimeMachineCursor.safeParse({ ...input, id: fake }).success).toBe(false);
    }
  });

  it('binds history to the real actor, action source and execution lineage', () => {
    const value = queued();
    expect(TimeMachineNativeWrite.safeParse(value).success).toBe(true);
    expect(TimeMachineNativeWrite.safeParse({ ...value, actor: { kind: 'operator', userId: id('99') } }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...value, actor: { kind: 'mcp_key', keyId: id('99') } }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...value, direction: 'inverse' }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...value, phase: 'observed_requested' }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...value, inverseSummaries: [{ operation: { executionId: id('1'), planId: id('20') },
      snapshot: value.execution.snapshot, mirror: emptyMirror }] }).success).toBe(false);
    expect(TimeMachineNativeWrite.safeParse({ ...value, restored: true }).success).toBe(false);
  });
});
