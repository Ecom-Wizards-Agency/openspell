import { describe, expect, it } from 'vitest';
import type { CampaignRow, EntityRow } from '@wizard-ads/shared';
import { readWorkbook } from '@wizard-ads/campaigns';
import { buildCampaignBuilderArtifact } from './artifact.js';

const PROFILE = '50505050-5050-4050-8050-505050505050';
const TODAY = '2026-08-28';

function campaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    entityType: 'campaign',
    profileId: PROFILE,
    amazonId: '1001',
    adProduct: 'SP',
    name: 'Synthetic campaign',
    state: 'enabled',
    portfolioId: '9001',
    budgetAmount: 20,
    budgetType: 'daily',
    targetingType: 'manual',
    biddingStrategy: 'legacy_for_sales',
    placementBidding: null,
    startDate: '2026-08-01',
    endDate: '2026-12-31',
    ...overrides,
  };
}

const context = (entities: readonly EntityRow[] = [campaign()]) => ({
  today: TODAY,
  client: 'Synthetic profile',
  marketplace: 'US',
  entities,
});

describe('Campaign Builder artifact boundary', () => {
  it('preflights CREATE mode and exports the same complete row set', () => {
    const artifact = buildCampaignBuilderArtifact('create', {
      client: 'Synthetic profile',
      marketplace: 'US',
      naming: {
        variableOrder: ['Goal', 'SP', 'MatchType', 'ProductName', 'TargetDescriptor', 'EW'],
        delimiter: ' | ', suffix: 'EW', custom1Value: '', custom2Value: '',
      },
      defaults: { dailyBudget: 10, keywordBid: 0.5, state: 'paused' },
      campaigns: [{
        campaignType: 'Halo', productName: 'Widget', targetDescriptor: 'long-tail',
        sku: ['SKU-1'], keywords: ['synthetic widget keyword'],
      }],
    }, context());
    expect(artifact.preview.ready).toBe(true);
    expect(artifact.preview.counts.create).toBe(4);
    expect(artifact.preview.rows).toHaveLength(4);
    expect(artifact.workbook).not.toBeNull();
    const written = readWorkbook(artifact.workbook?.bytes ?? new Uint8Array());
    expect(written.rows).toHaveLength(artifact.preview.rows.length);
  });

  it('keeps portfolio and End Date on a sparse Campaign UPDATE', () => {
    const artifact = buildCampaignBuilderArtifact('update', {
      allowEndDateClear: false,
      changes: { campaigns: [{ campaignId: '1001', dailyBudget: 25 }] },
    }, context());
    expect(artifact.preview).toMatchObject({
      ready: true,
      exportable: true,
      counts: { update: 1, archive: 0, create: 0 },
    });
    const row = artifact.preview.rows[0];
    expect(row).toMatchObject({
      Entity: 'Campaign',
      Operation: 'Update',
      'Campaign ID': '1001',
      'Daily Budget': 25,
      'Portfolio ID': '9001',
      'End Date': '20261231',
    });
    const written = readWorkbook(artifact.workbook?.bytes ?? new Uint8Array());
    expect(written.rows).toHaveLength(1);
  });

  it('blocks an unmatched id instead of emitting a create', () => {
    const artifact = buildCampaignBuilderArtifact('update', {
      changes: { campaigns: [{ campaignId: '9999', dailyBudget: 25 }] },
    }, context());
    expect(artifact.preview.ready).toBe(false);
    expect(artifact.preview.exportable).toBe(false);
    expect(artifact.preview.rows).toEqual([]);
    expect(artifact.preview.issues[0]).toContain("campaign_id '9999' not found");
    expect(artifact.workbook).toBeNull();
  });

  it('makes an all-no-op plan ready to review but impossible to download', () => {
    const artifact = buildCampaignBuilderArtifact('update', {
      changes: { campaigns: [{ campaignId: '1001', dailyBudget: 20, state: 'enabled' }] },
    }, context());
    expect(artifact.preview.ready).toBe(true);
    expect(artifact.preview.exportable).toBe(false);
    expect(artifact.preview.rows).toHaveLength(0);
    expect(artifact.preview.review).toEqual([
      'SKIPPED (no-op): Campaign 1001 (Synthetic campaign) has no fields that differ from the export',
    ]);
  });
});
