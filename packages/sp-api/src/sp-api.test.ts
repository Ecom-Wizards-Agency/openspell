import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SpApiClient, SpApiParseError } from './index.js';
import { batchSqpAsins, buildSqpReportRequests, parseSqpReport } from './sqp.js';
import type { FetchLike } from './types.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

function accessProvider() {
  const value = ['synthetic', 'access', 'value'].join('-');
  return { getAccessToken: async () => value };
}

function validSqpRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startDate: '2026-08-16',
    endDate: '2026-08-22',
    asin: 'B000000001',
    searchQueryData: {
      searchQuery: 'Synthetic Query',
      searchQueryScore: 1,
      searchQueryVolume: 100,
    },
    impressionData: {
      totalQueryImpressionCount: 80,
      asinImpressionCount: 8,
      asinImpressionShare: 0.1,
    },
    clickData: { totalClickCount: 20, asinClickCount: 4, asinClickShare: 0.2 },
    cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 0.2 },
    purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 2, asinPurchaseShare: 0.4 },
    ...overrides,
  };
}

describe('SQP request construction', () => {
  it('deduplicates and batches ASIN options without crossing 200 characters', () => {
    const asins = Array.from({ length: 25 }, (_, index) => `B${String(index).padStart(9, '0')}`);
    const batches = batchSqpAsins([...asins, asins[0] ?? '']);
    expect(batches.flat()).toEqual(asins);
    expect(batches.every((batch) => batch.join(' ').length <= 200)).toBe(true);
  });

  it('builds one-marketplace, one-week report requests', () => {
    const requests = buildSqpReportRequests({
      marketplaceId: 'marketplace-1',
      asins: ['B000000001', 'B000000002'],
      weekStart: '2026-08-16',
      weekEnd: '2026-08-22',
    });
    expect(requests).toEqual([
      {
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        marketplaceId: 'marketplace-1',
        dataStartTime: '2026-08-16T00:00:00.000Z',
        dataEndTime: '2026-08-22T23:59:59.999Z',
        reportOptions: { reportPeriod: 'WEEK', asin: 'B000000001 B000000002' },
      },
    ]);
  });

  it('rejects periods that are not exactly Sunday through Saturday', () => {
    expect(() =>
      buildSqpReportRequests({
        marketplaceId: 'marketplace-1',
        asins: ['B000000001'],
        weekStart: '2026-08-17',
        weekEnd: '2026-08-22',
      }),
    ).toThrow(SpApiParseError);
  });
});

describe('SQP document parsing', () => {
  it('accounts for all inputs and makes deduplication explicit', () => {
    const result = parseSqpReport(
      {
        dataByAsin: [
          validSqpRow(),
          validSqpRow(),
          validSqpRow({ clickData: { totalClickCount: 'invalid' } }),
        ],
      },
      { profileId: PROFILE_ID, marketplaceId: 'marketplace-1' },
    );
    expect(result.counts).toEqual({
      sourceAsins: 1,
      sourceRows: 3,
      parsedRows: 2,
      deduplicatedRows: 1,
      refusedRows: 1,
      upserts: 1,
    });
    expect(result.counts.parsedRows + result.counts.refusedRows).toBe(result.counts.sourceRows);
    expect(result.rows).toHaveLength(result.counts.upserts);
    expect(result.rows[0]?.normalizedQuery).toBe('synthetic query');
  });
});

describe('SP-API Reports client', () => {
  it('sends the required headers and exactly one marketplace', async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify({ reportId: 'report-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new SpApiClient({
      endpoint: 'https://sellingpartnerapi-na.example.test',
      accessTokenProvider: accessProvider(),
      userAgent: 'wizard-ads/synthetic',
      fetch: fetchImpl,
      now: () => new Date('2026-08-28T00:00:00Z'),
    });
    await expect(
      client.createReport({
        reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
        marketplaceId: 'marketplace-1',
        dataStartTime: '2026-08-16',
        dataEndTime: '2026-08-22',
        reportOptions: { reportPeriod: 'WEEK', asin: 'B000000001' },
      }),
    ).resolves.toEqual({ reportId: 'report-1' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('x-amz-access-token')).toBe('synthetic-access-value');
    expect(requests[0]?.headers.get('x-amz-date')).toBe('20260828T000000Z');
    expect(requests[0]?.body).toMatchObject({ marketplaceIds: ['marketplace-1'] });
  });

  it('honors Retry-After for throttled reads', async () => {
    let attempts = 0;
    const slept: number[] = [];
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ errors: [{ code: 'QuotaExceeded' }] }), {
          status: 429,
          headers: { 'retry-after': '2' },
        });
      }
      return new Response(
        JSON.stringify({
          reportId: 'report-1',
          processingStatus: 'DONE',
          reportDocumentId: 'document-1',
        }),
        { status: 200 },
      );
    };
    const client = new SpApiClient({
      endpoint: 'https://sellingpartnerapi-na.example.test',
      accessTokenProvider: accessProvider(),
      userAgent: 'wizard-ads/synthetic',
      fetch: fetchImpl,
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    await expect(client.getReport('report-1')).resolves.toMatchObject({ processingStatus: 'DONE' });
    expect(attempts).toBe(2);
    expect(slept).toEqual([2_000]);
  });

  it('downloads and decodes a GZIP document without sending an auth header', async () => {
    const receivedHeaders: Headers[] = [];
    const payload = { dataByAsin: [validSqpRow()] };
    const fetchImpl: FetchLike = async (_url, init) => {
      receivedHeaders.push(new Headers(init?.headers));
      return new Response(gzipSync(JSON.stringify(payload)), { status: 200 });
    };
    const client = new SpApiClient({
      endpoint: 'https://sellingpartnerapi-na.example.test',
      accessTokenProvider: accessProvider(),
      userAgent: 'wizard-ads/synthetic',
      fetch: fetchImpl,
    });
    await expect(
      client.downloadReportDocument({
        reportDocumentId: 'document-1',
        url: 'https://documents.example.test/report',
        compressionAlgorithm: 'GZIP',
      }),
    ).resolves.toEqual(payload);
    expect(receivedHeaders[0]?.get('x-amz-access-token')).toBeNull();
  });
});
