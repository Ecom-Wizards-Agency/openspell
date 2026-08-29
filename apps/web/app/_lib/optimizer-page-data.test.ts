import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  listRuns: vi.fn(),
  listRecommendations: vi.fn(),
  readWorkspace: vi.fn(),
  loadAccountRows: vi.fn(),
  loadLedger: vi.fn(),
  loadCampaignFacts: vi.fn(),
}));

vi.mock('@wizard-ads/db', () => ({
  getRecommendationRun: mocks.getRun,
  listRecommendationRuns: mocks.listRuns,
  listRecommendations: mocks.listRecommendations,
  readOptimizationWorkspace: mocks.readWorkspace,
}));

vi.mock('@wizard-ads/worker', () => ({
  RECOMMENDATIONS_ENGINE_VERSION: 'synthetic-engine',
}));

vi.mock('./dashboard-data', () => ({
  loadProfileDailyRows: mocks.loadAccountRows,
  loadReportLedger: mocks.loadLedger,
}));

vi.mock('./optimizer-campaigns', () => ({
  loadOptimizerCampaignFacts: mocks.loadCampaignFacts,
}));

import { loadOptimizerPageData } from './optimizer-page-data';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('optimizer page loading plan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspace.mockResolvedValue({ groups: [], campaigns: [] });
    mocks.loadLedger.mockResolvedValue([]);
    mocks.loadCampaignFacts.mockResolvedValue([]);
    mocks.getRun.mockResolvedValue(null);
    mocks.listRecommendations.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts independent reads before run discovery and scans profile facts once', async () => {
    const runs = deferred<[]>();
    mocks.listRuns.mockReturnValue(runs.promise);
    mocks.loadAccountRows.mockResolvedValue([
      { date: '2026-07-20' },
      { date: '2026-08-01' },
      { date: '2026-08-20' },
    ]);

    const resultPromise = loadOptimizerPageData({
      handle: {} as DbHandle,
      orgId: 'synthetic-org',
      profile: { id: 'synthetic-profile', label: 'Synthetic profile' },
      period: { start: '2026-08-01', end: '2026-08-20' },
      settledComparison: { start: '2026-07-20', end: '2026-07-31' },
    });

    await Promise.resolve();
    expect(mocks.readWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.loadAccountRows).toHaveBeenCalledTimes(1);
    expect(mocks.loadLedger).toHaveBeenCalledTimes(1);
    expect(mocks.loadCampaignFacts).toHaveBeenCalledTimes(1);
    expect(mocks.listRuns).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'synthetic-org',
      profileId: 'synthetic-profile',
      limit: 20,
    });
    expect(mocks.loadAccountRows).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-org',
      'synthetic-profile',
      'Synthetic profile',
      { start: '2026-07-20', end: '2026-08-20' },
    );

    runs.resolve([]);
    const result = await resultPromise;
    expect(result.periodRows.map((row) => row.date)).toEqual(['2026-08-01', '2026-08-20']);
    expect(result.comparisonRows.map((row) => row.date)).toEqual(['2026-07-20']);
    expect(mocks.loadAccountRows).toHaveBeenCalledTimes(1);
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.listRecommendations).not.toHaveBeenCalled();
  });

  it('finishes on the slowest independent read instead of adding query phases', async () => {
    vi.useFakeTimers();
    const after = <T,>(milliseconds: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), milliseconds));
    mocks.listRuns.mockReturnValue(after(40, []));
    mocks.readWorkspace.mockReturnValue(after(60, { groups: [], campaigns: [] }));
    mocks.loadAccountRows.mockReturnValue(after(60, []));
    mocks.loadLedger.mockReturnValue(after(60, []));
    mocks.loadCampaignFacts.mockReturnValue(after(60, []));

    let resolved = false;
    const result = loadOptimizerPageData({
      handle: {} as DbHandle,
      orgId: 'synthetic-org',
      profile: { id: 'synthetic-profile', label: 'Synthetic profile' },
      period: { start: '2026-08-01', end: '2026-08-20' },
      settledComparison: null,
    }).then((value) => {
      resolved = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(59);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ periodRows: [], comparisonRows: [] });
    expect(resolved).toBe(true);
  });
});
