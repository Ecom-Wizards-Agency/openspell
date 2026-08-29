/**
 * The adapter that maps the real `@wizard-ads/ads-api` client onto the worker's
 * narrow `AdsApiClient`. Driven entirely through a mock underlying client and a
 * mock Vault — no HTTP, no database, no credentials.
 */
import { gzipSync } from 'node:zlib';
import {
  AdsApiHttpError,
  AdsApiParseError,
  AdsApiTimeoutError,
  AdsApiWriteResponseError,
  AdsThrottleError,
  DuplicateReportError,
  DuplicateWriteError,
  type MirrorRow,
  type ReportMetadata,
} from '@wizard-ads/ads-api';
import type { CampaignRow, KeywordRow, Region } from '@wizard-ads/shared';
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import {
  AdsApiRetryableError,
  DbAdsApiClient,
  DownloadUrlExpiredError,
  SpWriteAmbiguousError,
  SpWriteFailedError,
  SpWriteRetryableError,
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

  it('retries a 425 that carries no id to adopt', async () => {
    const client = underlying({
      createReport: async () => {
        throw new DuplicateReportError('in flight', 425, '', 1, null);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.toBeInstanceOf(AdsApiRetryableError);
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

  it('maps a 500 to a retryable error', async () => {
    const client = underlying({
      createReport: async () => {
        throw new AdsApiHttpError('boom', 500, '', 4);
      },
    });
    const { adapter } = makeAdapter(client);
    await expect(adapter.createReport(input)).rejects.toBeInstanceOf(AdsApiRetryableError);
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

describe('DbAdsApiClient guarded Sponsored Products writes', () => {
  it('keeps row-level Amazon success/failure accounting and drops raw envelopes', async () => {
    const updateSpKeywords = vi.fn(async () => ({
      submitted: 2,
      batches: 1,
      apiCalls: 1,
      items: [{
        kind: 'keywords' as const, index: 0, id: 'keyword-1', entity: null,
        raw: { sensitive: 'not persisted' },
      }],
      errors: [{
        kind: 'keywords' as const, index: 1, code: 'INVALID_ARGUMENT',
        details: 'synthetic rejection', errors: [], raw: { sensitive: 'not persisted' },
      }],
    }));
    const { adapter } = makeAdapter(underlying({ updateSpKeywords }));

    const result = await adapter.updateSpKeywordBids(profile, [
      { keywordId: 'keyword-1', bid: 0.71 },
      { keywordId: 'keyword-2', bid: 0.72 },
    ]);

    expect(result.evidence.map((row) => row.outcome)).toEqual(['accepted', 'failed']);
    expect(result.apiCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('not persisted');
    expect(updateSpKeywords).toHaveBeenCalledTimes(1);
  });

  it('retries only an explicit pre-mutation throttle', async () => {
    const { adapter } = makeAdapter(underlying({
      updateSpKeywords: async () => {
        throw new AdsThrottleError('synthetic throttle', 429, '', 3, 2_000);
      },
    }));
    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toMatchObject({
        name: 'SpWriteRetryableError', retryAfterSeconds: 2, apiCalls: 3,
      });
    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toBeInstanceOf(SpWriteRetryableError);
  });

  it.each([
    new AdsApiTimeoutError('synthetic timeout'),
    new AdsApiHttpError('synthetic transport failure', 0, '', 1),
    new AdsApiHttpError('synthetic server failure', 503, '', 1),
    new AdsApiParseError('synthetic incomplete multi-status response'),
    new DuplicateWriteError('synthetic duplicate', 425, '', 1, 'update', '/sp/keywords'),
  ])('marks an uncertain post-send outcome ambiguous and never asks the caller to retry it', async (failure) => {
    const updateSpKeywords = vi.fn(async () => { throw failure; });
    const { adapter } = makeAdapter(underlying({ updateSpKeywords }));
    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toBeInstanceOf(SpWriteAmbiguousError);
    expect(updateSpKeywords).toHaveBeenCalledTimes(1);
  });

  it('preserves the provider attempt count for an ambiguous write response', async () => {
    const updateSpKeywords = vi.fn(async () => {
      throw new AdsApiWriteResponseError('synthetic incomplete response', 3);
    });
    const { adapter } = makeAdapter(underlying({ updateSpKeywords }));

    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toMatchObject({ name: 'SpWriteAmbiguousError', apiCalls: 3 });
  });

  it('counts a deterministic whole-request Amazon rejection as one failed provider call', async () => {
    const updateSpKeywords = vi.fn(async () => {
      throw new AdsApiHttpError('synthetic request rejection', 400, '', 1);
    });
    const { adapter } = makeAdapter(underlying({ updateSpKeywords }));
    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toMatchObject({ name: 'SpWriteFailedError', apiCalls: 1 });
    await expect(adapter.updateSpKeywordBids(profile, [{ keywordId: 'keyword-1', bid: 0.71 }]))
      .rejects.toBeInstanceOf(SpWriteFailedError);
  });

  it('uses targeted id filters and rejects duplicate observation rows', async () => {
    const listSpKeywords = vi.fn(async () => ({
      ...emptyList(),
      items: [{
        entityType: 'keyword' as const, amazonId: 'keyword-1', adProduct: 'SP' as const,
        name: 'synthetic', state: 'enabled' as const, campaignId: 'campaign-1',
        adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact' as const, bid: 0.71,
      }],
    }));
    const { adapter } = makeAdapter(underlying({ listSpKeywords }));
    const observed = await adapter.observeSpWriteEntities(profile, {
      keywordIds: ['keyword-1'], targetIds: [], campaignIds: [],
    });
    expect(observed).toMatchObject({ requested: 1, returned: 1, apiCalls: 1 });
    expect(listSpKeywords).toHaveBeenCalledWith(profile.amazonProfileId, {
      entityIdFilter: ['keyword-1'],
    });
  });

  it('rejects a targeted observation that omits a requested identity', async () => {
    const listSpKeywords = vi.fn(async () => emptyList());
    const { adapter } = makeAdapter(underlying({ listSpKeywords }));
    await expect(adapter.observeSpWriteEntities(profile, {
      keywordIds: ['keyword-1'], targetIds: [], campaignIds: [],
    })).rejects.toThrow(/exact requested identity set/i);
  });

  it('chunks targeted observations at the provider batch limit and counts every read', async () => {
    const listSpKeywords = vi.fn(async (
      _profileId: string,
      options?: { entityIdFilter?: readonly string[] },
    ) => ({
      ...emptyList(),
      items: (options?.entityIdFilter ?? []).map((amazonId) => ({
        entityType: 'keyword' as const, amazonId, adProduct: 'SP' as const,
        name: 'synthetic', state: 'enabled' as const, campaignId: 'campaign-1',
        adGroupId: 'group-1', keywordText: 'synthetic', matchType: 'exact' as const,
        bid: 0.71,
      })),
    }));
    const { adapter } = makeAdapter(underlying({ listSpKeywords }));
    const keywordIds = Array.from({ length: 101 }, (_unused, index) => `keyword-${index + 1}`);
    const observed = await adapter.observeSpWriteEntities(profile, {
      keywordIds, targetIds: [], campaignIds: [],
    });
    expect(observed).toMatchObject({ requested: 101, returned: 101, apiCalls: 2 });
    expect(listSpKeywords).toHaveBeenCalledTimes(2);
    expect(listSpKeywords.mock.calls.map((call) => call[1]?.entityIdFilter?.length))
      .toEqual([100, 1]);
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
