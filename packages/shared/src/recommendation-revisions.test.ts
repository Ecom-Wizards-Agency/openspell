import { describe, expect, it } from 'vitest';
import { serializeApplyRows } from './apply.js';
import { RecommendationBidDecimal, RecommendationRevisionReceipt, RecommendationRevisionRequest,
  RecommendationRevisionSelection, recommendationBidNumber } from './recommendation-revisions.js';

const id = (tail: string) => `aaaaaaaa-aaaa-4aaa-8aaa-${tail.padStart(12, '0')}`;
const request = { requestId: id('1'), profileId: id('2'), recommendationId: id('3'),
  expectedRevisionId: null, proposedValue: '0.7', note: 'Reviewed bid' };

describe('proposal revision contract', () => {
  it('normalizes entered decimals and identities without accepting a caller actor', () => {
    expect(RecommendationRevisionRequest.parse({ ...request, requestId: request.requestId.toUpperCase(),
      proposedValue: ' 000.7000 ', note: ' Reviewed bid ' })).toEqual(request);
    expect(RecommendationRevisionRequest.safeParse({ ...request, actor: { orgId: id('4'), userId: id('5') } }).success).toBe(false);
    for (const proposedValue of ['0', '-0.7', '1e-1', '0.00001', '100000000', '0,7', 'NaN', '', '.7', '1.']) {
      expect(RecommendationRevisionRequest.safeParse({ ...request, proposedValue }).success).toBe(false);
    }
    expect(RecommendationBidDecimal.safeParse('0.7000').success).toBe(false);
  });

  it('preserves numeric JSON for legacy cap validation at decimal boundaries', () => {
    for (const decimal of ['0.0001', '0.1', '0.8123', '99999999.9999']) {
      const number = recommendationBidNumber(decimal);
      expect(JSON.stringify(number)).toBe(decimal);
      const rows = serializeApplyRows([{ entityType: 'keyword', entityId: 'synthetic-keyword', field: 'bid', old: 0.9, new: number }]);
      const parsed = JSON.parse(rows) as Array<{ new: number }>;
      expect(typeof parsed[0]!.new).toBe('number');
      expect(String(parsed[0]!.new)).toBe(decimal);
    }
    expect(() => recommendationBidNumber('0.12345')).toThrow();
  });

  it('requires an explicit unique revision reference for every selected recommendation', () => {
    const base = { recommendationId: id('3'), revisionId: null };
    expect(RecommendationRevisionSelection.parse([base])).toEqual([base]);
    expect(RecommendationRevisionSelection.safeParse([]).success).toBe(false);
    expect(RecommendationRevisionSelection.safeParse([{ recommendationId: id('3') }]).success).toBe(false);
    expect(RecommendationRevisionSelection.safeParse([base, { ...base, recommendationId: id('3').toUpperCase() }]).success).toBe(false);
  });

  it('records a changed immutable receipt without claiming a current approval', () => {
    const receipt = { schemaVersion: 'openspell.recommendation-revision.v1', requestId: id('1'), profileId: id('2'),
      recommendationId: id('3'), revisionId: id('6'), previousRevisionId: null, actor: { orgId: id('4'), userId: id('5') },
      currencyCode: 'USD', priorProposedValue: '0.8', proposedValue: '0.7', note: 'Reviewed bid',
      recordedStatus: 'proposed', recordedAt: '2026-09-05T12:00:00.123456Z' };
    expect(RecommendationRevisionReceipt.parse(receipt)).toEqual(receipt);
    for (const patch of [{ previousRevisionId: id('6') }, { proposedValue: '0.8' }, { recordedStatus: 'accepted' }]) {
      expect(RecommendationRevisionReceipt.safeParse({ ...receipt, ...patch }).success).toBe(false);
    }
  });
});
