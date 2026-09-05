import { describe, expect, it } from 'vitest';
import type { TimeMachineNativeWrite } from '@wizard-ads/shared/time-machine-writes';
import { inverseHistoryLabel, nativeMirrorLabel, nativeWriteLabel, operationHistoryHref, timelineCursor, timelineOperation } from './timeline.js';

const executionId = '11111111-1111-4111-8111-111111111111';
const planId = '22222222-2222-4222-8222-222222222222';
const actionId = '33333333-3333-4333-8333-333333333333';
describe('native Time Machine server wiring', () => {
  it('round trips exact native cursors and rejects partial or repeated query parameters', () => {
    const query = { before_at: '2026-09-05T12:00:00.123456Z', before_id: `write:${planId}:${actionId}:keyword.bid` };
    expect(timelineCursor(query)).toEqual({ observedAt: query.before_at, id: query.before_id });
    expect(timelineCursor({ before_at: query.before_at })).toBeNull();
    expect(timelineCursor({ ...query, before_id: [query.before_id, query.before_id] })).toBeNull();
    expect(timelineCursor({ ...query, before_at: '2026-02-30T12:00:00Z' })).toBeNull();
  });

  it('requires both identities for a reversal link and preserves them in the destination', () => {
    expect(timelineOperation({ execution: executionId, plan: planId })).toEqual({ executionId, planId });
    expect(timelineOperation({ execution: executionId })).toBeNull();
    expect(timelineOperation({ execution: executionId, plan: [planId] })).toBeNull();
    const url = new URL(operationHistoryHref(actionId, { executionId, planId }), 'https://openspell.invalid');
    expect(url.pathname).toBe('/time-machine');
    expect(Object.fromEntries(url.searchParams)).toEqual({ profile: actionId, execution: executionId, plan: planId });
  });

  it('does not describe a refused or unresolved reversal as restored', () => {
    // Only presentation fields are needed here; persistence/contract suites validate full evidence.
    const inverse = (status: string) => ({ snapshot: { status } }) as TimeMachineNativeWrite['inverseSummaries'][number];
    expect(inverseHistoryLabel(inverse('refused'))).toBe('Reversion refused');
    expect(inverseHistoryLabel(inverse('failed'))).toBe('Reversion failed');
    expect(inverseHistoryLabel(inverse('ambiguous'))).toBe('Reversion outcome uncertain');
    expect(inverseHistoryLabel(inverse('awaiting_observation'))).toBe('Reversion pending');
    expect(inverseHistoryLabel(inverse('succeeded'))).toBe('Reversion observed in Amazon');
  });

  it('shows provider observation and local reconciliation separately', () => {
    const write = { execution: { admission: 'queued' }, direction: 'inverse', phase: 'observed_requested',
      observation: {}, mirrorReceipt: null } as TimeMachineNativeWrite;
    expect(nativeWriteLabel(write)).toBe('Reversion · Observed in Amazon');
    expect(nativeMirrorLabel(write)).toBe('Local update pending');
    expect(nativeWriteLabel({ ...write, phase: 'conflict' })).toBe('Reversion · Conflicting Amazon value');
  });
});
