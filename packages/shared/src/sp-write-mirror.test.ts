import { describe, expect, it } from 'vitest';
import { KeywordMirrorMergeCounts, KeywordMirrorMergeRequest, SpWriteMirrorCounts, SpWriteMirrorReceipt } from './sp-write-mirror.js';

const id = '00000000-0000-4000-8000-000000000001';
const observedAt = '2026-09-05T10:00:00.000Z';
const reconciledAt = '2026-09-05T10:00:01.000Z';
const money = (amount: string) => ({ amount, currencyCode: 'USD' });
const promoted = {
  schemaVersion: 'openspell.sp-write-mirror-receipt.v1', orgId: id, profileId: id, executionId: id,
  planId: id, observationId: id, observationFingerprint: 'a'.repeat(64), actionId: id,
  amazonEntityId: 'synthetic-keyword', changeKey: 'keyword.bid', observationOutcome: 'observed_requested',
  outcome: 'promoted', before: money('0.9'), observed: money('0.7'), after: money('0.7'),
  entityChangeId: '9007199254740993', changeAttribution: 'write', observedAt, reconciledAt, bidObservedAt: observedAt,
};

describe('mirror evidence contracts', () => {
  it('preserves exact decimal and bigint text in an attributed promotion', () => {
    expect(SpWriteMirrorReceipt.parse(promoted).entityChangeId).toBe('9007199254740993');
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, after: money('0.71') }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, before: money('0.7') }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, entityChangeId: null }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, reconciledAt: '2026-09-05T09:00:00.000Z' }).success).toBe(false);
  });

  it('does not turn a conflicting provider read into an OpenSpell write', () => {
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, observationOutcome: 'conflict' }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...promoted, observationOutcome: 'conflict', changeAttribution: 'observation' }).success).toBe(true);
  });

  it('distinguishes an unchanged mirror from a superseded or missing value', () => {
    const unchanged = { ...promoted, entityChangeId: null, changeAttribution: null };
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'already_current', before: money('0.7') }).success).toBe(true);
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'already_current' }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'superseded', after: money('0.9') }).success).toBe(true);
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'superseded' }).success).toBe(false);
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'missing', before: null, after: null, bidObservedAt: null }).success).toBe(true);
    expect(SpWriteMirrorReceipt.safeParse({ ...unchanged, outcome: 'missing' }).success).toBe(false);
  });

  it('reconciles every observation and every ordinary sync input exactly once', () => {
    expect(SpWriteMirrorCounts.safeParse({ observations: 4, promoted: 1, alreadyCurrent: 1, superseded: 1, missing: 1 }).success).toBe(true);
    expect(SpWriteMirrorCounts.safeParse({ observations: 4, promoted: 1, alreadyCurrent: 1, superseded: 0, missing: 1 }).success).toBe(false);
    const merge = { listed: 10, upserted: 10, currentBidInputs: 7, staleBidInputs: 3, bidChanges: 2, changes: 3,
      tombstonesOffered: 4, tombstoned: 1, staleTombstones: 3 };
    expect(KeywordMirrorMergeCounts.safeParse(merge).success).toBe(true);
    expect(KeywordMirrorMergeCounts.safeParse({ ...merge, bidChanges: 8 }).success).toBe(false);
    expect(KeywordMirrorMergeCounts.safeParse({ ...merge, staleBidInputs: 2 }).success).toBe(false);
    expect(KeywordMirrorMergeCounts.safeParse({ ...merge, staleTombstones: 0 }).success).toBe(false);
    expect(KeywordMirrorMergeCounts.safeParse({ ...merge, changes: 2 }).success).toBe(false);
  });

  it('rejects duplicate or mixed-scope keyword inputs before a mirror transaction', () => {
    const row = { entityType: 'keyword', profileId: id, amazonId: 'synthetic-keyword', adProduct: 'SP', name: null,
      state: 'enabled', campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group', keywordText: 'synthetic',
      matchType: 'exact', bid: 0.7 };
    const request = { orgId: id, profileId: id, adProduct: 'SP', readStartedAt: observedAt, full: true, rows: [row] };
    expect(KeywordMirrorMergeRequest.safeParse(request).success).toBe(true);
    expect(KeywordMirrorMergeRequest.safeParse({ ...request, rows: [row, row] }).success).toBe(false);
    expect(KeywordMirrorMergeRequest.safeParse({ ...request, adProduct: 'SB' }).success).toBe(false);
    expect(KeywordMirrorMergeRequest.safeParse({ ...request, rows: [{ ...row, bid: -1 }] }).success).toBe(false);
  });
});
