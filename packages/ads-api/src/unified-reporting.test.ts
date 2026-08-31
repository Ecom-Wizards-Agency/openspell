import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import {
  AdsApiConfigError,
  AdsApiHttpError,
  AdsApiParseError,
  UnifiedReportCreateAmbiguousError,
} from './errors.js';
import {
  UNIFIED_ACCOUNT_IDS,
  UNIFIED_DEFINITION,
  UNIFIED_MIXED_RESPONSE,
  UNIFIED_REPORT_IDS,
  unifiedReportMetadata,
} from './__fixtures__/unified-reporting.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import {
  UNIFIED_CREATE_REPORTS_PATH,
  UNIFIED_RETRIEVE_REPORTS_PATH,
  prepareUnifiedReportCreate,
  prepareUnifiedReportRetrieve,
} from './unified-reporting.js';

const CREDENTIALS = {
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-client-value',
  refreshToken: 'synthetic-refresh-value',
};

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: async () => undefined,
    }),
  };
}

describe('Unified Reporting preparation', () => {
  it('encodes the official create wrappers and snapshots mutable inputs', () => {
    const definition = {
      ...UNIFIED_DEFINITION,
      periods: [...UNIFIED_DEFINITION.periods],
      fields: [...UNIFIED_DEFINITION.fields],
      filter: { ...UNIFIED_DEFINITION.filter },
    };
    const operation = prepareUnifiedReportCreate({
      advertiserAccountIds: [...UNIFIED_ACCOUNT_IDS],
      reports: [definition],
    });

    definition.fields[0] = 'mutated.after.prepare';
    definition.periods[0] = { startDate: '2020-01-01', endDate: '2020-01-01' };
    const body = JSON.parse(operation.body) as Record<string, unknown>;

    expect(operation).toMatchObject({
      path: UNIFIED_CREATE_REPORTS_PATH,
      idempotent: false,
      submittedCount: 1,
    });
    expect(body).toEqual({
      reports: [{
        format: 'CSV',
        periods: [{ datePeriod: { startDate: '2026-08-01', endDate: '2026-08-07' } }],
        query: {
          fields: ['advertiserAccount.id', 'campaign.id', 'metric.impressions'],
          filter: { includeZeroImpressions: false },
        },
      }],
      accessRequestedAccounts: [{ advertiserAccountId: UNIFIED_ACCOUNT_IDS[0] }],
    });
  });

  it('encodes retrieve as one idempotent batch read', () => {
    const operation = prepareUnifiedReportRetrieve(UNIFIED_REPORT_IDS);
    expect(operation).toMatchObject({
      path: UNIFIED_RETRIEVE_REPORTS_PATH,
      idempotent: true,
      submittedCount: 2,
      body: JSON.stringify({ reportIds: UNIFIED_REPORT_IDS }),
    });
  });

  it.each([
    ['missing accounts', { advertiserAccountIds: [], reports: [UNIFIED_DEFINITION] }],
    ['blank account', { advertiserAccountIds: [' '], reports: [UNIFIED_DEFINITION] }],
    ['empty periods', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, periods: [] }] }],
    ['empty fields', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, fields: [] }] }],
    ['duplicate fields', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, fields: ['same', 'same'] }] }],
    ['invalid date', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, periods: [{ startDate: '2026-02-30', endDate: '2026-03-01' }] }] }],
    ['reversed date', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, periods: [{ startDate: '2026-03-02', endDate: '2026-03-01' }] }] }],
    ['non-finite filter', { advertiserAccountIds: UNIFIED_ACCOUNT_IDS, reports: [{ ...UNIFIED_DEFINITION, filter: { value: Number.NaN } }] }],
  ] as const)('refuses %s before transport', (_label, input) => {
    expect(() => prepareUnifiedReportCreate(input)).toThrow(AdsApiConfigError);
  });

  it('refuses duplicate report IDs before transport', () => {
    expect(() => prepareUnifiedReportRetrieve(['same', 'same'])).toThrow(AdsApiConfigError);
  });
});

describe('Unified Reporting exact accounting', () => {
  const create = () => prepareUnifiedReportCreate({
    advertiserAccountIds: UNIFIED_ACCOUNT_IDS,
    reports: [UNIFIED_DEFINITION, { ...UNIFIED_DEFINITION, fields: ['campaign.id'] }],
  });

  it('returns one ordered outcome per submitted definition', () => {
    const parsed = create().decodeResponse(UNIFIED_MIXED_RESPONSE);
    expect(parsed.submittedCount).toBe(2);
    expect(parsed.outcomes.map(({ index, kind }) => ({ index, kind }))).toEqual([
      { index: 0, kind: 'error' },
      { index: 1, kind: 'success' },
    ]);
    expect(parsed.outcomes[0]).toMatchObject({
      submitted: UNIFIED_DEFINITION,
      errors: [{ code: 'QUERY_INVALID', message: 'Provider rejected this report definition' }],
    });
    expect(parsed.outcomes[1]).toMatchObject({
      report: { reportId: UNIFIED_REPORT_IDS[1], completedParts: { kind: 'not-returned' } },
    });
  });

  it.each([
    ['non-object', null],
    ['missing success', { error: [] }],
    ['missing error', { success: [] }],
    ['negative index', { success: [], error: [{ index: -1, errors: [] }] }],
    ['fractional index', { success: [], error: [{ index: 0.5, errors: [] }] }],
    ['out-of-range index', { success: [], error: [{ index: 2, errors: [] }] }],
    ['duplicate index', { success: [{ index: 0, report: unifiedReportMetadata('one') }], error: [{ index: 0, errors: [] }] }],
    ['missing index', { success: [{ index: 0, report: unifiedReportMetadata('one') }], error: [] }],
    ['non-object success', { success: [null], error: [{ index: 1, errors: [] }] }],
    ['non-object error', { success: [{ index: 0, report: unifiedReportMetadata('one') }], error: [null] }],
  ] as const)('fails closed for %s', (_label, body) => {
    expect(() => create().decodeResponse(body)).toThrow(AdsApiParseError);
  });

  it('accepts null buckets but rejects unproven completed parts', () => {
    const single = prepareUnifiedReportRetrieve([UNIFIED_REPORT_IDS[0]]);
    expect(() => single.decodeResponse({
      success: [{
        index: 0,
        report: unifiedReportMetadata(UNIFIED_REPORT_IDS[0], { completedReportParts: [{ url: 'unproven' }] }),
      }],
      error: null,
    })).toThrow(/unproven completedReportParts/);
  });

  it('binds retrieve success to the exact requested ID', () => {
    const single = prepareUnifiedReportRetrieve([UNIFIED_REPORT_IDS[0]]);
    expect(() => single.decodeResponse({
      success: [{ index: 0, report: unifiedReportMetadata('different-report') }],
      error: null,
    })).toThrow(/does not match/);
  });
});

describe('Unified Reporting client transport', () => {
  it('creates without a profile-scope header and preserves every outcome', async () => {
    const { server, client } = clientFor([{
      method: 'POST',
      match: UNIFIED_CREATE_REPORTS_PATH,
      responses: [{ status: 207, json: {
        error: null,
        success: [{ index: 0, report: unifiedReportMetadata(UNIFIED_REPORT_IDS[0]) }],
      } }],
    }]);

    const result = await client.createUnifiedReports({
      advertiserAccountIds: UNIFIED_ACCOUNT_IDS,
      reports: [UNIFIED_DEFINITION],
    });

    expect(result).toMatchObject({ submittedCount: 1 });
    const request = server.requestsFor(UNIFIED_CREATE_REPORTS_PATH)[0];
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['accept']).toBe('application/json');
    expect(request?.headers['amazon-advertising-api-scope']).toBeUndefined();
  });

  it('makes no request for empty create or retrieve batches', async () => {
    const { server, client } = clientFor([]);
    await expect(client.createUnifiedReports({ advertiserAccountIds: [], reports: [] }))
      .resolves.toEqual({ submittedCount: 0, outcomes: [] });
    await expect(client.retrieveUnifiedReports([]))
      .resolves.toEqual({ submittedCount: 0, outcomes: [] });
    expect(server.requestsFor(UNIFIED_CREATE_REPORTS_PATH)).toHaveLength(0);
    expect(server.requestsFor(UNIFIED_RETRIEVE_REPORTS_PATH)).toHaveLength(0);
  });

  it.each([
    ['server-response', 503],
    ['response-decoding', 207],
  ] as const)('quarantines an ambiguous create after %s', async (phase, status) => {
    const json = status === 207 ? { success: [], error: [] } : { code: 'UNAVAILABLE' };
    const { server, client } = clientFor([{
      method: 'POST',
      match: UNIFIED_CREATE_REPORTS_PATH,
      responses: [{ status, json }],
    }]);

    const error = await client.createUnifiedReports({
      advertiserAccountIds: UNIFIED_ACCOUNT_IDS,
      reports: [UNIFIED_DEFINITION],
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnifiedReportCreateAmbiguousError);
    expect(error).toMatchObject({ phase, submitted: 1, status });
    expect(server.requestsFor(UNIFIED_CREATE_REPORTS_PATH)).toHaveLength(1);
  });

  it('does not hide an explicit non-server refusal as an ambiguous create', async () => {
    const { client } = clientFor([{
      method: 'POST',
      match: UNIFIED_CREATE_REPORTS_PATH,
      responses: [{ status: 400, json: { code: 'INVALID' } }],
    }]);
    const error = await client.createUnifiedReports({
      advertiserAccountIds: UNIFIED_ACCOUNT_IDS,
      reports: [UNIFIED_DEFINITION],
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AdsApiHttpError);
    expect(error).not.toBeInstanceOf(UnifiedReportCreateAmbiguousError);
    expect(error).toMatchObject({ body: '', status: 400 });
  });

  it('retries retrieve after a 5xx because it is an idempotent read', async () => {
    const { server, client } = clientFor([{
      method: 'POST',
      match: UNIFIED_RETRIEVE_REPORTS_PATH,
      responses: [
        { status: 503, json: { code: 'UNAVAILABLE' } },
        { status: 207, json: {
          error: null,
          success: [{ index: 0, report: unifiedReportMetadata(UNIFIED_REPORT_IDS[0]) }],
        } },
      ],
    }]);
    const result = await client.retrieveUnifiedReports([UNIFIED_REPORT_IDS[0]]);
    expect(result.outcomes[0]).toMatchObject({ kind: 'success', submitted: UNIFIED_REPORT_IDS[0] });
    expect(server.requestsFor(UNIFIED_RETRIEVE_REPORTS_PATH)).toHaveLength(2);
  });

  it('does not retain a provider body when retrieve is refused', async () => {
    const { client } = clientFor([{
      method: 'POST',
      match: UNIFIED_RETRIEVE_REPORTS_PATH,
      responses: [{ status: 400, json: { message: 'synthetic query details' } }],
    }]);
    const error = await client.retrieveUnifiedReports([UNIFIED_REPORT_IDS[0]])
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AdsApiHttpError);
    expect(error).toMatchObject({ body: '', status: 400 });
  });
});
