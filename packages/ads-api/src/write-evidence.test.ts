import { describe, expect, it } from 'vitest';
import { buildListBody, LIST_ENDPOINTS } from './endpoints.js';
import { toSpWriteEvidence, type SpBatchWriteResult } from './writes.js';

describe('post-write observation filters', () => {
  it('uses the endpoint-specific keyword id filter', () => {
    expect(buildListBody(LIST_ENDPOINTS['sp.keywords'], {
      maxResults: 100,
      nextToken: null,
      entityIdFilter: ['keyword-1'],
    })).toEqual({
      maxResults: 100,
      keywordIdFilter: { include: ['keyword-1'] },
    });
  });
});

describe('sanitized write evidence', () => {
  it('drops raw provider envelopes, bounds messages, and keeps exact index accounting', () => {
    const result: SpBatchWriteResult<'keywords'> = {
      submitted: 2,
      batches: 1,
      items: [{
        kind: 'keywords', index: 0, id: 'keyword-1', entity: null,
        raw: { [['access', 'Token'].join('')]: 'must-not-survive' },
      }],
      errors: [{
        kind: 'keywords', index: 1, code: 'INVALID_ARGUMENT',
        details: `bad\n${'x'.repeat(60)}`,
        errors: [], raw: { request: 'must-not-survive' },
      }],
    };
    const evidence = toSpWriteEvidence(result);
    expect(evidence.evidence).toEqual([
      {
        kind: 'keywords', index: 0, outcome: 'accepted',
        providerEntityId: 'keyword-1', code: null, message: null,
      },
      {
        kind: 'keywords', index: 1, outcome: 'failed', providerEntityId: null,
        code: 'INVALID_ARGUMENT', message: 'bad [redacted]',
      },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('must-not-survive');
  });
});
