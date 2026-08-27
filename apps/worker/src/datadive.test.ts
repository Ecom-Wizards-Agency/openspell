import type {
  DataDiveQuota,
  RankRadarData,
  RankRadarList,
} from '@wizard-ads/datadive-api';
import type { RankSyncJob } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  ConflictingRankObservation,
  consolidateRankObservations,
  createDataDiveRankSyncHandlerWithStore,
  type DataDiveRankClient,
  type DataDiveRankSyncStore,
  type RankObservationInput,
} from './datadive.js';
import { PermanentJobError, RetryableJobError } from './worker.js';

const payload: RankSyncJob = {
  type: 'rank.sync',
  orgId: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222',
};

const availableQuota: DataDiveQuota = {
  nextRefreshDate: '2026-09-01T00:00:00.000Z',
  features: {
    RANK_RADAR_KEYWORDS: { used: 2, capacity: 100, details: {} },
  },
  details: {},
};

function radarList(marketplace = 'US'): RankRadarList {
  return {
    pages: 1,
    total: 1,
    items: [{
      id: 'radar-unit-1',
      asin: 'B000UNIT001',
      marketplace,
      keywordCount: 1,
      title: 'Unit-test product',
      imageUrl: 'https://images.invalid/unit.jpg',
      details: {},
    }],
  };
}

function rankData(date = '2026-08-27'): RankRadarData {
  return {
    keywords: [{
      id: 'keyword-unit-1',
      keyword: 'unit test keyword',
      searchVolume: 20,
      ranks: [{ date, organicRank: 8, details: {} }],
      details: {},
    }],
    details: {},
  };
}

function setup(input: {
  quota?: DataDiveQuota;
  radars?: RankRadarList;
  data?: RankRadarData;
  configuredRadarIds?: string[];
}) {
  const calls = {
    listed: 0,
    data: [] as string[],
    loaded: [] as RankObservationInput[][],
    success: 0,
    failures: [] as { message: string; permanent: boolean }[],
  };
  const client: DataDiveRankClient = {
    getQuota: async () => input.quota ?? availableQuota,
    listRankRadars: async () => { calls.listed += 1; return input.radars ?? radarList(); },
    getRankRadarData: async (id) => { calls.data.push(id); return input.data ?? rankData(); },
  };
  const store: DataDiveRankSyncStore = {
    resolve: async () => ({
      connectionId: 'connection-unit-1',
      credential: 'fake-credential',
      countryCode: 'US',
      timezone: 'UTC',
      ...(input.configuredRadarIds === undefined ? {} : { configuredRadarIds: input.configuredRadarIds }),
    }),
    load: async (rows) => {
      calls.loaded.push([...rows]);
      return { offered: rows.length, unique: rows.length, duplicates: 0, written: rows.length };
    },
    recordSuccess: async () => { calls.success += 1; },
    recordFailure: async (_id, message, permanent) => { calls.failures.push({ message, permanent }); },
  };
  const handler = createDataDiveRankSyncHandlerWithStore({
    store,
    clientFactory: () => client,
    now: () => new Date('2026-08-27T12:00:00Z'),
  });
  return { handler, calls };
}

describe('DataDive rank sync handler', () => {
  it('loads one profile-local day and records count evidence', async () => {
    const { handler, calls } = setup({ configuredRadarIds: ['radar-unit-1'] });
    const result = await handler(payload);

    expect(calls.data).toEqual(['radar-unit-1']);
    expect(calls.loaded[0]).toEqual([expect.objectContaining({
      orgId: payload.orgId,
      profileId: payload.profileId,
      observedOn: '2026-08-27',
      organicRank: 8,
      marketplace: 'US',
      source: 'rank_radar',
    })]);
    expect(result).toMatchObject({ radarsListed: 1, radarsSelected: 1, observations: 1, loaded: 1 });
    expect(calls.success).toBe(1);
    expect(calls.failures).toEqual([]);
  });

  it('lets job payload radar ids override connection config', async () => {
    const { handler, calls } = setup({ configuredRadarIds: ['radar-not-selected'] });
    await handler({ ...payload, radarIds: ['radar-unit-1'] });
    expect(calls.data).toEqual(['radar-unit-1']);
  });

  it('fails permanently before a data read or load on marketplace mismatch', async () => {
    const { handler, calls } = setup({ radars: radarList('DE') });

    await expect(handler(payload)).rejects.toBeInstanceOf(PermanentJobError);
    expect(calls.data).toEqual([]);
    expect(calls.loaded).toEqual([]);
    expect(calls.failures).toEqual([{
      message: expect.stringContaining('marketplace DE does not match designated profile marketplace US'),
      permanent: true,
    }]);
  });

  it('skips reads, records health, and requests a retry when quota is exhausted', async () => {
    const { handler, calls } = setup({
      quota: {
        ...availableQuota,
        features: { RANK_RADAR_KEYWORDS: { used: 100, capacity: 100, details: {} } },
      },
    });
    const error = await handler(payload).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(RetryableJobError);
    expect((error as RetryableJobError).retryAfterSeconds).toBeGreaterThan(60);
    expect(calls.listed).toBe(0);
    expect(calls.loaded).toEqual([]);
    expect(calls.failures).toEqual([{
      message: 'DataDive Rank Radar keyword quota is exhausted; rank reads were skipped',
      permanent: false,
    }]);
  });
});

describe('rank observation grain', () => {
  const row: RankObservationInput = {
    orgId: payload.orgId,
    profileId: payload.profileId,
    asin: 'B000UNIT001',
    keyword: 'unit test keyword',
    observedOn: '2026-08-27',
    organicRank: 8,
    marketplace: 'US',
    source: 'rank_radar',
  };

  it('collapses identical duplicate conflict keys and counts them', () => {
    expect(consolidateRankObservations([row, { ...row }])).toEqual({ rows: [row], duplicates: 1 });
  });

  it('refuses two values for one database grain', () => {
    expect(() => consolidateRankObservations([row, { ...row, organicRank: 9 }]))
      .toThrow(ConflictingRankObservation);
  });
});
