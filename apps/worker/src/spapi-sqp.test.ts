import { describe, expect, it, vi } from 'vitest';
import { createSpApiSqpRequestHandler, spApiEndpointForRegion } from './spapi-sqp.js';
import { SqpWorkflowPermanentError } from './sqp.js';

const payload = {
  type: 'sqp.request' as const,
  orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002',
  marketplaceId: 'synthetic-marketplace',
  asins: ['B000000001'],
  weekStart: '2026-08-16',
  weekEnd: '2026-08-22',
};

describe('SP-API SQP runtime composition', () => {
  it('maps only the three authoritative SP-API regions', () => {
    expect(spApiEndpointForRegion('NA')).toBe('https://sellingpartnerapi-na.amazon.com');
    expect(spApiEndpointForRegion('EU')).toBe('https://sellingpartnerapi-eu.amazon.com');
    expect(spApiEndpointForRegion('FE')).toBe('https://sellingpartnerapi-fe.amazon.com');
  });

  it('fails before any provider call when exact binding ownership is absent', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 500 }));
    const sql = async () => [];
    const handler = createSpApiSqpRequestHandler({
      handle: { sql } as never,
      lwaClientId: ['synthetic', 'app-id'].join('-'),
      lwaClientSecret: ['synthetic', 'app-key'].join('-'),
      fetch,
    });

    await expect(handler(payload, { jobId: '00000000-0000-4000-8000-000000000003' }))
      .rejects.toBeInstanceOf(SqpWorkflowPermanentError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
