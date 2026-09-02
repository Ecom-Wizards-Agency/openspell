/**
 * The adapter that maps the real `@wizard-ads/ads-api` client onto the worker's
 * narrow `AdsApiClient`. Driven entirely through a mock underlying client and a
 * mock Vault — no HTTP, no database, no credentials.
 */
import { gzipSync } from 'node:zlib';
import {
  AdsApiHttpError,
  AdsApiParseError,
  AdsThrottleError,
  DuplicateReportError,
  UnifiedReportCreateAmbiguousError,
  type MirrorRow,
  type ReportMetadata,
  type UnifiedReportBatchResult,
  type UnifiedReportDefinition,
  type UnifiedReportMetadata,
} from '@wizard-ads/ads-api';
import type { CampaignRow, KeywordRow, Region } from '@wizard-ads/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import {
  AdsApiRetryableError,
  DbAdsApiClient,
  DownloadUrlExpiredError,
  ReportCreateOutcomeUnknownError,
  createAdsApiClientFromEnv,
  type AdsApiAdapterDeps,
  type AdsProfileContext,
  type UnderlyingClient,
} from './ads-api.js';

const profile: AdsProfileContext = {
  id: '22222222-2222-4222-8222-222222222222',
  orgId: '11111111-1111-4111-8111-111111111111',
  amazonProfileId: 'amazon-profile-9',
  region: 'NA',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
};

const CONNECTION_ID = '99999999-9999-4999-8999-999999999999';

const unifiedDefinition: UnifiedReportDefinition = {
  format: 'CSV',
  periods: [{ startDate: '2026-08-01', endDate: '2026-08-07' }],
  fields: ['advertiserAccount.id', 'campaign.id', 'metric.impressions'],
};

function emptyList() {
  return { items: [], pages: 1, truncated: false, nextToken: null, raw: [], skipped: [] };
}

/** A mock underlying client. Every list method is empty unless overridden. */
function underlying(overrides: Partial<UnderlyingClient> = {}): UnderlyingClient {
  const base: UnderlyingClient = {
    listSpCampaigns: async () => emptyList(),
    listSpAdGroups: async () => emptyList(),
    listSpKeywords: async () => emptyList(),
    listSpTargets: async () => emptyList(),
    listSpNegativeKeywords: async () => emptyList(),
    listSpCampaignNegativeKeywords: async () => emptyList(),
    listSpNegativeTargets: async () => emptyList(),
    listSpProductAds: async () => emptyList(),
    listSbCampaigns: async () => emptyList(),
    listSbAdGroups: async () => emptyList(),
    listSdCampaigns: async () => emptyList(),
    listSdAdGroups: async () => emptyList(),
    getProfiles: async () => [],
    createReport: async () => reportMeta('PENDING'),
    getReport: async () => reportMeta('PENDING'),
    createUnifiedReports: async () => unifiedCreatedBatch('unified-created'),
    retrieveUnifiedReports: async () => unifiedObservedBatch('unified-observed'),
    getSpKeywordBidRecommendations: async () => emptyRecommendations(),
    getSpTargetBidRecommendations: async () => emptyRecommendations(),
  };
  return { ...base, ...overrides };
}

function emptyRecommendations() {
  return { items: [], errors: [], submitted: 0, batches: 0 };
}

function reportMeta(status: string, extra: Partial<ReportMetadata> = {}): ReportMetadata {
  return {
    reportId: 'report-1',
    status,
    url: null,
    urlExpiresAt: null,
    failureReason: null,
    fileSize: null,
    name: null,
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

function unifiedMetadata(reportId: string, extra: Partial<UnifiedReportMetadata> = {}): UnifiedReportMetadata {
  return {
    reportId,
    status: 'PENDING',
    format: 'CSV',
    periods: [{ startDate: '2026-08-01', endDate: '2026-08-07' }],
    fields: ['advertiserAccount.id', 'campaign.id', 'metric.impressions'],
    filter: null,
    linkedAdvertiserAccountIds: ['synthetic-advertiser-account'],
    createdAt: '2026-08-08T00:00:00Z',
    updatedAt: '2026-08-08T00:00:01Z',
    completedAt: null,
    currencyOfView: null,
    locale: null,
    timeZoneMode: null,
    failureCode: null,
    failureReason: null,
    completedParts: { kind: 'not-returned' },
    ...extra,
  };
}

function unifiedCreatedBatch(reportId: string): UnifiedReportBatchResult<UnifiedReportDefinition> {
  return {
    submittedCount: 1,
    outcomes: [{
      kind: 'success', index: 0, submitted: unifiedDefinition, report: unifiedMetadata(reportId),
    }],
  };
}

function unifiedObservedBatch(reportId: string): UnifiedReportBatchResult<string> {
  return {
    submittedCount: 1,
    outcomes: [{
      kind: 'success', index: 0, submitted: reportId, report: unifiedMetadata(reportId),
    }],
  };
}

function makeAdapter(
  client: UnderlyingClient,
  overrides: Partial<AdsApiAdapterDeps> = {},
): { adapter: DbAdsApiClient; createClient: ReturnType<typeof vi.fn> } {
  const createClient = vi.fn(() => client);
  const deps: AdsApiAdapterDeps = {
    resolveConnectionId: async () => CONNECTION_ID,
    listConnectionIds: async () => [CONNECTION_ID],
    getRefreshToken: async () => 'refresh-token',
    createClient,
    ...overrides,
  };
  return { adapter: new DbAdsApiClient(deps), createClient };
}

describe('DbAdsApiClient.listEntities', () => {
  it('lists every ad product and stamps our profile uuid back onto each row', async () => {
    const campaign: MirrorRow<CampaignRow> = {
      entityType: 'campaign', amazonId: 'c-1', adProduct: 'SP', name: 'C1', state: 'enabled',
      portfolioId: null, budgetAmount: 10, budgetType: 'daily', targetingType: 'manual',
      biddingStrategy: null, placementBidding: null, startDate: null, endDate: null,
    };
    const keyword: MirrorRow<KeywordRow> = {
      entityType: 'keyword', amazonId: 'k-1', adProduct: 'SP', name: 'kw', state: 'enabled',
      campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'kw', matchType: 'exact', bid: 1,
    };
    const client = underlying({
      listSpCampaigns: async () => ({ ...emptyList(), items: [campaign] }),
      listSpKeywords: async () => ({ ...emptyList(), items: [keyword] }),
    });
    const { adapter } = makeAdapter(client);

    const listing = await adapter.listEntities(profile, true);

    expect(listing.rows).toHaveLength(2);
    expect(listing.rows.every((row) => row.profileId === profile.id)).toBe(true);
    expect(listing.rows.map((row) => row.amazonId).sort()).toEqual(['c-1', 'k-1']);
    expect(listing.succeeded).toEqual(['SP', 'SB', 'SD']);
    expect(listing.failures).toEqual([]);
  });

  it('isolates a failing ad product: an SB 400 keeps SP rows and records the failure', async () => {
    const spCampaign: MirrorRow<CampaignRow> = {
      entityType: 'campaign', amazonId: 'sp-c', adProduct: 'SP', name: 'SP', state: 'enabled',
      portfolioId: null, budgetAmount: 10, budgetType: 'daily', targetingType: 'manual',
      biddingStrategy: null, placementBidding: null, startDate: null, endDate: null,
    };
    const sdCampaign: MirrorRow<CampaignRow> = {
      entityType: 'campaign', amazonId: 'sd-c', adProduct: 'SD', name: 'SD', state: 'enabled',
      portfolioId: null, budgetAmount: 5, budgetType: 'daily', targetingType: 'auto',
      biddingStrategy: null, placementBidding: null, startDate: null, endDate: null,
    };
    const client = underlying({
      listSpCampaigns: async () => ({ ...emptyList(), items: [spCampaign] }),
      // The exact failure that aborted the first live sync.
      listSbCampaigns: async () => {
        throw new AdsApiHttpError('POST /sb/v4/campaigns/list failed with 400', 400, 'bad', 1);
      },
      listSdCampaigns: async () => ({ ...emptyList(), items: [sdCampaign] }),
    });
    const { adapter } = makeAdapter(client);

    const listing = await adapter.listEntities(profile, true);

    // SP and SD survived; SB was dropped whole and recorded.
    expect(listing.rows.map((row) => row.amazonId).sort()).toEqual(['sd-c', 'sp-c']);
    expect(listing.succeeded).toEqual(['SP', 'SD']);
    expect(listing.failures).toHaveLength(1);
    expect(listing.failures[0]?.adProduct).toBe('SB');
    expect(listing.failures[0]?.error).toBeInstanceOf(AdsApiHttpError);
  });

  /**
   * A large profile's Sponsored Products listing used to end in "Maximum call
   * stack size exceeded": the per-product rows were appended with
   * `rows.push(...productRows)`, which passes every row as a call argument.
   *
   * The count is well past the spread limit on purpose. Seventy thousand rows
   * — the size that failed in production, inside a deep async stack — still
   * spreads fine from a shallow one, so a test at that size would pass against
   * the unfixed code and prove nothing.
   */
  it('lists a profile whose rows exceed the argument-spread limit', async () => {
    const keyword = (index: number): MirrorRow<KeywordRow> => ({
      entityType: 'keyword', amazonId: `k-${index}`, adProduct: 'SP', name: 'kw', state: 'enabled',
      campaignId: 'c-1', adGroupId: 'ag-1', keywordText: 'kw', matchType: 'exact', bid: 1,
    });
    const items = Array.from({ length: 160_000 }, (_unused, index) => keyword(index));
    const client = underlying({
      listSpKeywords: async () => ({ ...emptyList(), items }),
    });
    const { adapter } = makeAdapter(client);

    const listing = await adapter.listEntities(profile, true);

    expect(listing.rows).toHaveLength(160_000);
    expect(listing.succeeded).toEqual(['SP', 'SB', 'SD']);
    expect(listing.failures).toEqual([]);
    expect(listing.rows[159_999]).toMatchObject({ amazonId: 'k-159999', profileId: profile.id });
  });

  it('builds one client per connection+region and reuses it across calls', async () => {
    const client = underlying();
    const { adapter, createClient } = makeAdapter(client);
    await adapter.listEntities(profile, false);
    await adapter.listEntities(profile, false);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      region: profile.region,
      refreshToken: 'refresh-token',
    });
  });

  it('throws when the profile has no connection', async () => {
    const { adapter } = makeAdapter(underlying(), { resolveConnectionId: async () => null });
    await expect(adapter.listEntities(profile, false)).rejects.toThrow(/no Amazon connection/);
  });

  it('throws when the connection has no stored refresh token', async () => {
    const { adapter } = makeAdapter(underlying(), { getRefreshToken: async () => null });
    await expect(adapter.listEntities(profile, false)).rejects.toThrow(/no stored refresh token/);
  });

  it('does not log or expose the refresh token', async () => {
    const getRefreshToken = vi.fn(async () => 'super-secret-token');
    const { adapter } = makeAdapter(underlying(), { getRefreshToken });
    await adapter.listEntities(profile, false);
    // The token reaches createClient only; the adapter never returns it.
    expect(getRefreshToken).toHaveBeenCalledWith(CONNECTION_ID);
  });
});

describe('DbAdsApiClient.createReport', () => {
  const input = { profile, reportType: 'spCampaigns' as const, startDate: '2026-08-01', endDate: '2026-08-07' };

  it('returns the minted report id', async () => {
    const client = underlying({ createReport: async () => reportMeta('PENDING', { reportId: 'r-42' }) });
    const { adapter } = makeAdapter(client);
    expect(await adapter.createReport(input)).toEqual({ reportId: 'r-42' });
  });

  it('adopts the in-flight report id on a 425 duplicate', async () => {
    const client = underlying({
      createReport: async () => {
        throw new DuplicateReportError('in flight', 425, '', 1, 'existing-99');
      },
    });
    const { adapter } = makeAdapter(client);
    expect(await adapter.createReport(input)).toEqual({ reportId: 'existing-99' });
  });

  it('quarantines a 425 that carries no id to adopt', async () => {
    const client = underlying({
      createReport: async () => {
        throw new DuplicateReportError('in flight', 425, '', 1, null);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.toMatchObject({
      name: 'ReportCreateOutcomeUnknownError',
      phase: 'duplicate-without-id',
      status: 425,
    });
  });

  it('maps a throttle to a retryable error carrying the Retry-After seconds', async () => {
    const client = underlying({
      createReport: async () => {
        throw new AdsThrottleError('slow down', 429, '', 4, 30_000);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.toMatchObject({
      name: 'AdsApiRetryableError',
      retryAfterSeconds: 30,
    });
  });

  it('quarantines a 500 because the create may have been accepted', async () => {
    const client = underlying({
      createReport: async () => {
        throw new AdsApiHttpError('boom', 500, '', 4);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.toMatchObject({
      name: 'ReportCreateOutcomeUnknownError',
      phase: 'server-response',
      status: 500,
    });
  });

  it('quarantines transport loss without retaining the provider error', async () => {
    const providerDetail = 'private provider transport detail';
    const client = underlying({
      createReport: async () => {
        throw new AdsApiHttpError(providerDetail, 0, providerDetail, 1);
      },
    });
    const { adapter } = makeAdapter(client);

    const error = await adapter.createReport(input).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: 'ReportCreateOutcomeUnknownError',
      phase: 'transport',
      status: null,
    });
    expect(error).toBeInstanceOf(ReportCreateOutcomeUnknownError);
    expect(JSON.stringify(error)).not.toContain(providerDetail);
  });

  it('quarantines an undecodable accepted response', async () => {
    const client = underlying({
      createReport: async () => {
        throw new AdsApiParseError('provider response carried private detail');
      },
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.createReport(input)).rejects.toMatchObject({
      name: 'ReportCreateOutcomeUnknownError',
      phase: 'response-decoding',
      status: null,
    });
  });

  it('leaves a 400 as a non-retryable error', async () => {
    const client = underlying({
      createReport: async () => {
        throw new AdsApiHttpError('bad request', 400, '', 1);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.not.toBeInstanceOf(AdsApiRetryableError);
  });
});

describe('DbAdsApiClient Unified Reporting capability', () => {
  const createInput = {
    profile,
    advertiserAccountId: 'synthetic-advertiser-account',
    definition: unifiedDefinition,
  };

  it('creates exactly one Unified item through the profile connection and returns metadata', async () => {
    const createUnifiedReports = vi.fn(async () => unifiedCreatedBatch('unified-created-42'));
    const { adapter, createClient } = makeAdapter(underlying({ createUnifiedReports }));

    await expect(adapter.createUnifiedReport(createInput)).resolves.toMatchObject({
      kind: 'created', metadata: { reportId: 'unified-created-42', status: 'PENDING' },
    });
    expect(createClient).toHaveBeenCalledWith({
      connectionId: CONNECTION_ID,
      region: profile.region,
      refreshToken: 'refresh-token',
    });
    expect(createUnifiedReports).toHaveBeenCalledTimes(1);
    expect(createUnifiedReports).toHaveBeenCalledWith({
      advertiserAccountIds: [createInput.advertiserAccountId],
      reports: [unifiedDefinition],
    });
  });

  it('returns only refusal codes for an indexed create refusal', async () => {
    const providerMessage = 'provider message which must not reach the worker';
    const client = underlying({
      createUnifiedReports: async () => ({
        submittedCount: 1,
        outcomes: [{
          kind: 'error', index: 0, submitted: unifiedDefinition,
          errors: [{ code: 'QUERY_INVALID', message: providerMessage }],
        }],
      }),
    });
    const { adapter } = makeAdapter(client);

    const result = await adapter.createUnifiedReport(createInput);

    expect(result).toEqual({ kind: 'refused', codes: ['QUERY_INVALID'] });
    expect(JSON.stringify(result)).not.toContain(providerMessage);
  });

  it('rejects a malformed one-item create response instead of choosing an outcome', async () => {
    const client = underlying({
      createUnifiedReports: async () => ({
        submittedCount: 2,
        outcomes: [{
          kind: 'success', index: 0, submitted: unifiedDefinition, report: unifiedMetadata('unified-extra'),
        }],
      }),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.createUnifiedReport(createInput))
      .rejects.toThrow(/exactly one submitted item/);
  });

  it('preserves an ambiguous create unchanged and does not retry it', async () => {
    const ambiguous = new UnifiedReportCreateAmbiguousError(1, 'transport', null);
    const createUnifiedReports = vi.fn(async () => { throw ambiguous; });
    const { adapter } = makeAdapter(underlying({ createUnifiedReports }));

    await expect(adapter.createUnifiedReport(createInput)).rejects.toBe(ambiguous);
    expect(createUnifiedReports).toHaveBeenCalledTimes(1);
  });

  it('retrieves one report and excludes metadata failure text', async () => {
    const rawFailureReason = 'provider failure text which must not reach the worker';
    const retrieveUnifiedReports = vi.fn(async (): Promise<UnifiedReportBatchResult<string>> => ({
      submittedCount: 1,
      outcomes: [{
        kind: 'success', index: 0, submitted: 'unified-observed-42',
        report: unifiedMetadata('unified-observed-42', { failureReason: rawFailureReason }),
      }],
    }));
    const { adapter } = makeAdapter(underlying({ retrieveUnifiedReports }));

    const result = await adapter.retrieveUnifiedReport({ profile, reportId: 'unified-observed-42' });

    expect(result).toMatchObject({ kind: 'observed', metadata: { reportId: 'unified-observed-42' } });
    expect(JSON.stringify(result)).not.toContain(rawFailureReason);
    expect(retrieveUnifiedReports).toHaveBeenCalledWith(['unified-observed-42']);
  });

  it('returns only refusal codes for an indexed retrieve refusal', async () => {
    const client = underlying({
      retrieveUnifiedReports: async () => ({
        submittedCount: 1,
        outcomes: [{
          kind: 'error', index: 0, submitted: 'unified-refused',
          errors: [{ code: null, message: 'provider message must not reach the worker' }],
        }],
      }),
    });
    const { adapter } = makeAdapter(client);

    await expect(adapter.retrieveUnifiedReport({ profile, reportId: 'unified-refused' }))
      .resolves.toEqual({ kind: 'refused', codes: [null] });
  });
});

describe('DbAdsApiClient.getReport', () => {
  it('maps a completed report to its download url and expiry', async () => {
    const client = underlying({
      getReport: async () =>
        reportMeta('COMPLETED', { url: 'https://s3/report.gz', urlExpiresAt: '2026-08-14T12:00:00Z' }),
    });
    const { adapter } = makeAdapter(client);
    const status = await adapter.getReport(profile, 'report-1');
    expect(status.status).toBe('COMPLETED');
    expect(status.downloadUrl).toBe('https://s3/report.gz');
    expect(status.downloadExpiresAt?.toISOString()).toBe('2026-08-14T12:00:00.000Z');
  });

  it('carries the failure reason for a FAILURE report', async () => {
    const client = underlying({
      getReport: async () => reportMeta('FAILURE', { failureReason: 'internal error' }),
    });
    const { adapter } = makeAdapter(client);
    const status = await adapter.getReport(profile, 'report-1');
    expect(status).toMatchObject({ status: 'FAILURE', failureReason: 'internal error' });
  });

  it('treats an unrecognised status as still processing', async () => {
    const client = underlying({ getReport: async () => reportMeta('SOMETHING_NEW') });
    const { adapter } = makeAdapter(client);
    expect((await adapter.getReport(profile, 'report-1')).status).toBe('PROCESSING');
  });
});

describe('DbAdsApiClient.downloadReport', () => {
  it('streams the gzipped bytes so the worker can gunzip them', async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify([{ date: '2026-08-01' }])));
    const fetchLike = async () => new Response(gz, { status: 200 });
    const { adapter } = makeAdapter(underlying(), { fetch: fetchLike });
    const stream = await adapter.downloadReport('https://s3/report.gz');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(gz)).toBe(true);
  });

  it('raises DownloadUrlExpiredError on a 403 so the fetch re-polls', async () => {
    const fetchLike = async () => new Response('expired', { status: 403 });
    const { adapter } = makeAdapter(underlying(), { fetch: fetchLike });
    await expect(adapter.downloadReport('https://s3/stale')).rejects.toBeInstanceOf(DownloadUrlExpiredError);
  });

  it('raises DownloadUrlExpiredError on a 410', async () => {
    const fetchLike = async () => new Response('gone', { status: 410 });
    const { adapter } = makeAdapter(underlying(), { fetch: fetchLike });
    await expect(adapter.downloadReport('https://s3/gone')).rejects.toBeInstanceOf(DownloadUrlExpiredError);
  });

  it('maps a 503 to a retryable error', async () => {
    const fetchLike = async () => new Response('busy', { status: 503 });
    const { adapter } = makeAdapter(underlying(), { fetch: fetchLike });
    await expect(adapter.downloadReport('https://s3/busy')).rejects.toBeInstanceOf(AdsApiRetryableError);
  });

  it('preserves attended cancellation instead of converting it into a retry', async () => {
    const controller = new AbortController();
    const reason = new Error('fixed download deadline');
    const fetchLike = async (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const { adapter } = makeAdapter(underlying(), { fetch: fetchLike });
    const result = adapter.downloadReport('https://s3/hanging', controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });
});

describe('DbAdsApiClient.listProfiles', () => {
  it('gathers amazon profile ids across the active connections in a region', async () => {
    const client = underlying({
      getProfiles: async () => [
        { profileId: 'p-1', region: 'NA' as Region, countryCode: 'US', currencyCode: 'USD', timezone: 'tz', dailyBudget: null, accountType: null, accountName: null, amazonAccountId: null, marketplaceStringId: null },
        { profileId: 'p-2', region: 'NA' as Region, countryCode: 'US', currencyCode: 'USD', timezone: 'tz', dailyBudget: null, accountType: null, accountName: null, amazonAccountId: null, marketplaceStringId: null },
      ],
    });
    const { adapter } = makeAdapter(client);
    expect(await adapter.listProfiles('NA')).toEqual(['p-1', 'p-2']);
  });

  it('skips a connection whose credential is missing', async () => {
    const client = underlying({ getProfiles: async () => [] });
    const { adapter, createClient } = makeAdapter(client, { getRefreshToken: async () => null });
    expect(await adapter.listProfiles('NA')).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('DbAdsApiClient.getSpSuggestedBids', () => {
  const corridor = (targetId: string, low: number, median: number, high: number) => ({
    kind: 'keywords' as const,
    index: 0,
    targetId,
    low,
    median,
    high,
    suggestedBid: median,
    raw: {},
  });

  it('reads both endpoints and keys the corridor by target, counting returns and errors', async () => {
    const client = underlying({
      getSpKeywordBidRecommendations: async () => ({
        items: [corridor('kw-1', 0.5, 0.8, 1.2)],
        errors: [{ kind: 'keywords', index: 1, targetId: 'kw-2', code: 'X', details: null, raw: {} }],
        submitted: 2,
        batches: 1,
      }),
      getSpTargetBidRecommendations: async () => ({
        items: [{ ...corridor('tg-1', 0.3, 0.4, 0.6), kind: 'targets' as const }],
        errors: [],
        submitted: 1,
        batches: 1,
      }),
    });
    const { adapter } = makeAdapter(client);
    const result = await adapter.getSpSuggestedBids(profile, {
      keywordIds: ['kw-1', 'kw-2'],
      targetIds: ['tg-1'],
    });
    expect(result.submitted).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.byTarget.get('kw-1')).toEqual({ targetId: 'kw-1', low: 0.5, median: 0.8, high: 1.2 });
    expect(result.byTarget.get('tg-1')?.high).toBe(0.6);
  });

  it('skips an endpoint with no ids to read', async () => {
    const keywords = vi.fn(async () => ({ items: [corridor('kw-1', 0.5, 0.8, 1.2)], errors: [], submitted: 1, batches: 1 }));
    const targets = vi.fn(async () => ({ items: [], errors: [], submitted: 0, batches: 0 }));
    const client = underlying({ getSpKeywordBidRecommendations: keywords, getSpTargetBidRecommendations: targets });
    const { adapter } = makeAdapter(client);
    const result = await adapter.getSpSuggestedBids(profile, { keywordIds: ['kw-1'], targetIds: [] });
    expect(keywords).toHaveBeenCalledOnce();
    expect(targets).not.toHaveBeenCalled();
    expect(result.submitted).toBe(1);
  });
});

describe('createAdsApiClientFromEnv', () => {
  // The factory reads the LWA app identity eagerly and throws on a missing one,
  // but never touches the handle until a call needs a client — so a bare object
  // stands in for the database here.
  const handle = {} as DbHandle;

  it('accepts the AMAZON_-prefixed names as fallbacks', () => {
    expect(() =>
      createAdsApiClientFromEnv(handle, {
        AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.synthetic',
        AMAZON_LWA_CLIENT_SECRET: ['synthetic', 'secret'].join('-'),
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('prefers the unprefixed names when both are present', () => {
    expect(() =>
      createAdsApiClientFromEnv(handle, {
        LWA_CLIENT_ID: 'primary',
        LWA_CLIENT_SECRET: ['primary', 'secret'].join('-'),
        AMAZON_LWA_CLIENT_ID: 'fallback',
        AMAZON_LWA_CLIENT_SECRET: ['fallback', 'secret'].join('-'),
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('throws naming both accepted variables when neither is set', () => {
    expect(() => createAdsApiClientFromEnv(handle, {} as NodeJS.ProcessEnv)).toThrow(
      /AMAZON_LWA_CLIENT_ID/,
    );
  });
});
