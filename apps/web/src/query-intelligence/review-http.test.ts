import { describe, expect, it } from 'vitest';
import { CONTEXTUAL_NEGATIVE_ACTION_LIMIT as DATABASE_ACTION_LIMIT } from '@wizard-ads/db';
import {
  CONTEXTUAL_NEGATIVE_ACTION_LIMIT,
  CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT,
  parseDecisionRequest,
  parseExportFormat,
  parseExportRequest,
  readBoundedReviewJson,
} from './review-http';

const PROFILE = '11111111-1111-4111-8111-111111111111';
const expectation = (index: number) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  expectedFingerprint: 'a'.repeat(64),
});

function body() {
  return {
    profileId: PROFILE,
    marketplaceId: 'SYNTHETIC_MARKET',
    proposals: [expectation(1)],
  };
}

describe('contextual-negative route input', () => {
  it('keeps the web command cap equal to the database cap', () => {
    expect(CONTEXTUAL_NEGATIVE_ACTION_LIMIT).toBe(DATABASE_ACTION_LIMIT);
  });

  it('rejects attempted org and actor spoofing', () => {
    expect(() => parseDecisionRequest({ ...body(), orgId: PROFILE, decision: 'accepted' }))
      .toThrow(/derived from the authenticated request/i);
    expect(() => parseExportRequest({ ...body(), actorId: PROFILE, note: 'Synthetic export.', confirmed: true }))
      .toThrow(/derived from the authenticated request/i);
  });

  it('requires a non-empty bounded and duplicate-free explicit selection', () => {
    expect(() => parseDecisionRequest({ ...body(), proposals: [], decision: 'accepted' }))
      .toThrow(/non-empty explicit selection/i);
    expect(() => parseDecisionRequest({
      ...body(),
      proposals: Array.from({ length: CONTEXTUAL_NEGATIVE_ACTION_LIMIT + 1 }, (_, index) => expectation(index + 1)),
      decision: 'accepted',
    })).toThrow(/at most 500/i);
    expect(() => parseDecisionRequest({ ...body(), proposals: [expectation(1), expectation(1)], decision: 'accepted' }))
      .toThrow(/duplicated/i);
  });

  it('requires dismissal and export notes plus explicit export confirmation', () => {
    expect(() => parseDecisionRequest({ ...body(), decision: 'dismissed', note: '' })).toThrow(/needs a note/i);
    expect(() => parseExportRequest({ ...body(), note: 'Synthetic export.', confirmed: false })).toThrow(/confirm/i);
    expect(parseExportRequest({ ...body(), note: ' Synthetic export. ', confirmed: true }).note)
      .toBe('Synthetic export.');
  });

  it('accepts only the two stored artifact formats', () => {
    expect(parseExportFormat('csv')).toBe('csv');
    expect(parseExportFormat('json')).toBe('json');
    expect(() => parseExportFormat('xlsx')).toThrow(/csv or json/i);
  });

  it('rejects declared and streamed oversized JSON before parsing', async () => {
    const declared = new Request('http://localhost/review', {
      method: 'POST',
      headers: { 'content-length': String(CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT + 1) },
      body: '{}',
    });
    await expect(readBoundedReviewJson(declared)).rejects.toThrow(/exceeds/i);

    const streamed = new Request('http://localhost/review', {
      method: 'POST',
      body: JSON.stringify({ ...body(), decision: 'accepted', ignored: 'x'.repeat(CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT) }),
    });
    await expect(readBoundedReviewJson(streamed)).rejects.toThrow(/exceeds/i);
  });

  it('does not trust an understated content-length', async () => {
    const request = new Request('http://localhost/review', {
      method: 'POST',
      headers: { 'content-length': '2' },
      body: JSON.stringify({ ignored: 'x'.repeat(CONTEXTUAL_NEGATIVE_REQUEST_BYTE_LIMIT) }),
    });
    await expect(readBoundedReviewJson(request)).rejects.toThrow(/exceeds/i);
  });
});
