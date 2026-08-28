import { describe, expect, it } from 'vitest';
import type {
  ContextualNegativeProposal,
  QueryVocabularyEntry,
  SqpRequestJob,
} from '@wizard-ads/shared';
import type {
  ContextualProposalPersistenceCounts,
  SqpWeeklyPromotionInput,
  SqpWeeklyPromotionResult,
  WeeklyPpcQueryRecord,
} from '@wizard-ads/db';
import type {
  CreateReportInput,
  SpApiReport,
  SpApiReportDocument,
} from '@wizard-ads/sp-api';
import {
  InMemorySqpWorkflowCheckpoints,
  MinimumIntervalSqpProviderGate,
  runSqpRequestWorkflow,
  SqpWorkflowPermanentError,
  type SqpProviderGate,
  type SqpReportApi,
  type SqpWorkflowDataStore,
} from './sqp.js';

const ORG = '91919191-9191-4191-8191-919191919191';
const PROFILE = '92929292-9292-4292-8292-929292929292';
const MARKETPLACE = 'marketplace-synthetic';

describe('weekly SQP worker workflow', () => {
  it('resumes pending reports, conserves PPC spend, and reuses completed results', async () => {
    const api = new FakeSqpApi(['IN_PROGRESS', 'DONE'], document());
    const data = new FakeDataStore(vocabulary(), ppcRows());
    const gate = new RecordingGate();
    const checkpoints = new InMemorySqpWorkflowCheckpoints();
    const dependencies = {
      api,
      data,
      providerGate: gate,
      checkpoints,
      resolveRouting: ({ ppc, category }: Parameters<NonNullable<
        Parameters<typeof runSqpRequestWorkflow>[1]['resolveRouting']
      >>[0]) => {
        if (ppc.groupRole === null) return null;
        return {
          sourceGroupRole: ppc.groupRole,
          policy: {
            isolatesOwnBrandTraffic: true,
            competitorConquest: false,
            matchType: category === 'own_brand' ? 'negative_phrase' as const : 'negative_exact' as const,
          },
        };
      },
    };

    const pending = await runSqpRequestWorkflow(job(), dependencies);
    expect(pending).toMatchObject({
      status: 'pending',
      reports: { total: 1, requested: 1, ready: 0 },
      nextPollAfterSeconds: 300,
    });
    expect(api.actions).toEqual(['create_report', 'get_report']);
    expect(data.promotions).toHaveLength(0);

    const completed = await runSqpRequestWorkflow(job(), dependencies);
    expect(completed).toMatchObject({
      status: 'completed',
      reused: false,
      reports: { total: 1, created: 1, reusedCompleted: 0, empty: 0 },
      ingestion: { sourceRows: 3, parsedRows: 3, refusedRows: 0, upserts: 3, canonicalRows: 3 },
      categories: {
        rawTotal: 1_300,
        branded: 100,
        nonBranded: 1_200,
        addressableOpportunity: 200,
        detailed: { own_brand: 100, competitor: 0, core: 200, head: 1_000, excluded: 0, unreviewed: 0 },
      },
      joins: {
        asinExact: 1,
        profileOnly: 1,
        ambiguous: 1,
        unmatched: 1,
        inputRows: 4,
        outputRows: 4,
        inputSpend: 28,
        outputSpend: 28,
      },
      proposals: { offered: 2, upserts: 2, readBack: 2, preservedHumanDecisions: 0 },
    });
    expect(data.promotions).toHaveLength(1);
    expect(data.promotions[0]?.rows.map((row) => [row.normalizedQuery, row.category])).toEqual([
      ['synthetic brand mug', 'own_brand'],
      ['travel mug', 'core'],
      ['broad household item', 'head'],
    ]);
    expect(data.proposals[0]?.map((proposal) => [
      proposal.normalizedQuery,
      proposal.category,
      proposal.sourceGroupRole,
      proposal.status,
    ])).toEqual([
      ['synthetic brand mug', 'own_brand', 'profit', 'proposed'],
      ['prohibited material', 'excluded', 'profit', 'proposed'],
    ]);

    const actionCount = api.actions.length;
    const reused = await runSqpRequestWorkflow(job(), dependencies);
    expect(reused).toMatchObject({ status: 'completed', reused: true });
    expect(api.actions).toHaveLength(actionCount);
    expect(data.promotions).toHaveLength(1);
    expect(new Set(api.actions)).toEqual(new Set([
      'create_report',
      'get_report',
      'get_report_document',
      'download_report_document',
    ]));
    expect(gate.calls).toEqual(api.actions);
  });

  it('blocks canonical promotion when any known row shape is malformed', async () => {
    const malformed = document();
    const rows = malformed['dataByAsin'] as Array<Record<string, unknown>>;
    rows.push({ asin: 'B000000001', searchQueryData: { searchQuery: 'Incomplete' } });
    const data = new FakeDataStore(vocabulary(), []);
    await expect(runSqpRequestWorkflow(job(), {
      api: new FakeSqpApi(['DONE'], malformed),
      data,
      providerGate: new RecordingGate(),
      checkpoints: new InMemorySqpWorkflowCheckpoints(),
    })).rejects.toThrow(/refused 1 rows/);
    expect(data.promotions).toHaveLength(0);
  });

  it('treats an owned automatic cancellation as authoritative no-data without downloading', async () => {
    const api = new FakeSqpApi(['CANCELLED'], document());
    const data = new FakeDataStore([], []);
    const completed = await runSqpRequestWorkflow(job(), {
      api,
      data,
      providerGate: new RecordingGate(),
      checkpoints: new InMemorySqpWorkflowCheckpoints(),
      confirmCancelledNoData: async () => true,
    });
    expect(completed).toMatchObject({
      status: 'completed',
      reports: { empty: 1 },
      ingestion: { sourceRows: 0, upserts: 0, canonicalRows: 0 },
    });
    expect(data.promotions[0]).toMatchObject({
      requestedAsins: ['B000000001'],
      rows: [],
    });
    expect(api.actions).toEqual(['create_report', 'get_report']);
  });

  it('preserves canonical evidence when cancellation has no no-data confirmation', async () => {
    const data = new FakeDataStore([], []);
    await expect(runSqpRequestWorkflow(job(), {
      api: new FakeSqpApi(['CANCELLED'], document()),
      data,
      providerGate: new RecordingGate(),
      checkpoints: new InMemorySqpWorkflowCheckpoints(),
    })).rejects.toThrow(/lacks authoritative no-data confirmation/);
    expect(data.promotions).toHaveLength(0);
  });

  it('fails permanently on unknown or fatal provider states', async () => {
    for (const status of ['FATAL', 'NEW_PROVIDER_STATE']) {
      await expect(runSqpRequestWorkflow(job(), {
        api: new FakeSqpApi([status], document()),
        data: new FakeDataStore([], []),
        providerGate: new RecordingGate(),
        checkpoints: new InMemorySqpWorkflowCheckpoints(),
      })).rejects.toBeInstanceOf(SqpWorkflowPermanentError);
    }
  });
});

describe('SQP provider throttling seam', () => {
  it('enforces a minimum interval without hiding the sleep from tests', async () => {
    let current = 1_000;
    const slept: number[] = [];
    const gate = new MinimumIntervalSqpProviderGate(
      250,
      () => current,
      async (milliseconds) => {
        slept.push(milliseconds);
        current += milliseconds;
      },
    );
    await gate.beforeCall('create_report', 'request-one');
    current += 100;
    await gate.beforeCall('get_report', 'request-one');
    expect(slept).toEqual([150]);
  });

  it('serializes concurrent callers through the same gate', async () => {
    let current = 5_000;
    const slept: number[] = [];
    const gate = new MinimumIntervalSqpProviderGate(
      100,
      () => current,
      async (milliseconds) => {
        slept.push(milliseconds);
        current += milliseconds;
      },
    );
    await Promise.all([
      gate.beforeCall('create_report', 'one'),
      gate.beforeCall('create_report', 'two'),
      gate.beforeCall('get_report', 'one'),
    ]);
    expect(slept).toEqual([100, 100]);
  });
});

class RecordingGate implements SqpProviderGate {
  readonly calls: string[] = [];

  async beforeCall(operation: string, _requestKey: string): Promise<void> {
    this.calls.push(operation);
  }
}

class FakeSqpApi implements SqpReportApi {
  readonly actions: string[] = [];
  private statusIndex = 0;

  constructor(
    private readonly statuses: string[],
    private readonly payload: unknown,
  ) {}

  async createReport(_input: CreateReportInput): Promise<{ reportId: string }> {
    this.actions.push('create_report');
    return { reportId: 'report-synthetic' };
  }

  async getReport(reportId: string): Promise<SpApiReport> {
    this.actions.push('get_report');
    const status = this.statuses[Math.min(this.statusIndex, this.statuses.length - 1)]!;
    this.statusIndex += 1;
    return {
      reportId,
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      processingStatus: status,
      reportDocumentId: status === 'DONE' ? 'document-synthetic' : null,
      createdTime: '2026-08-23T00:00:00Z',
    };
  }

  async getReportDocument(reportDocumentId: string): Promise<SpApiReportDocument> {
    this.actions.push('get_report_document');
    return {
      reportDocumentId,
      url: 'https://documents.example.test/synthetic',
      compressionAlgorithm: null,
    };
  }

  async downloadReportDocument(_document: SpApiReportDocument): Promise<unknown> {
    this.actions.push('download_report_document');
    return this.payload;
  }
}

class FakeDataStore implements SqpWorkflowDataStore {
  readonly promotions: SqpWeeklyPromotionInput[] = [];
  readonly proposals: ContextualNegativeProposal[][] = [];

  constructor(
    private readonly vocabularyEntries: QueryVocabularyEntry[],
    private readonly ppc: WeeklyPpcQueryRecord[],
  ) {}

  async listVocabulary(): Promise<QueryVocabularyEntry[]> {
    return this.vocabularyEntries;
  }

  async promoteFacts(input: SqpWeeklyPromotionInput): Promise<SqpWeeklyPromotionResult> {
    this.promotions.push(input);
    return {
      ...input.counts,
      deletedRows: 0,
      upserts: input.rows.length,
      canonicalRows: input.rows.length,
    };
  }

  async listPpcFacts(): Promise<WeeklyPpcQueryRecord[]> {
    return this.ppc;
  }

  async persistProposals(input: {
    proposals: readonly ContextualNegativeProposal[];
  }): Promise<ContextualProposalPersistenceCounts> {
    this.proposals.push([...input.proposals]);
    return {
      offered: input.proposals.length,
      upserts: input.proposals.length,
      readBack: input.proposals.length,
      preservedHumanDecisions: 0,
    };
  }
}

function job(): SqpRequestJob {
  return {
    type: 'sqp.request',
    orgId: ORG,
    profileId: PROFILE,
    marketplaceId: MARKETPLACE,
    asins: ['B000000001'],
    weekStart: '2026-08-16',
    weekEnd: '2026-08-22',
  };
}

function vocabulary(): QueryVocabularyEntry[] {
  return [
    vocabularyEntry('own_brand_term', 'synthetic brand'),
    vocabularyEntry('core_term', 'travel mug'),
    vocabularyEntry('exclusion', 'prohibited material'),
  ];
}

function vocabularyEntry(
  kind: QueryVocabularyEntry['kind'],
  value: string,
): QueryVocabularyEntry {
  return {
    orgId: ORG,
    marketplaceId: MARKETPLACE,
    kind,
    value,
    normalizedValue: value,
    source: 'operator',
    approved: true,
    reviewedAt: '2026-08-15T00:00:00Z',
  };
}

function ppcRows(): WeeklyPpcQueryRecord[] {
  return [
    ppc('ppc-exact', 'Synthetic Brand Mug', 10, {
      asin: 'B000000001',
      attributedAsins: ['B000000001'],
      groupRole: 'profit',
    }),
    ppc('ppc-profile', 'Travel Mug', 8, { groupRole: 'discovery' }),
    ppc('ppc-ambiguous', 'Broad Household Item', 6, {
      attributedAsins: ['B000000001', 'B000000002'],
      groupRole: 'discovery',
    }),
    ppc('ppc-unmatched', 'Prohibited Material', 4, { groupRole: 'profit' }),
  ];
}

function ppc(
  id: string,
  searchTerm: string,
  spend: number,
  overrides: Partial<WeeklyPpcQueryRecord> = {},
): WeeklyPpcQueryRecord {
  return {
    id,
    profileId: PROFILE,
    marketplaceId: MARKETPLACE,
    weekStart: '2026-08-16',
    campaignId: `campaign-${id}`,
    adGroupId: `group-${id}`,
    searchTerm,
    asin: null,
    attributedAsins: [],
    spend,
    sales: spend * 2,
    clicks: spend,
    orders: 1,
    groupRole: null,
    ...overrides,
  };
}

function document(): Record<string, unknown> {
  return {
    dataByAsin: [
      sqpRow('Synthetic Brand Mug', 100),
      sqpRow('Travel Mug', 200),
      sqpRow('Broad Household Item', 1_000),
    ],
  };
}

function sqpRow(searchQuery: string, searchQueryVolume: number): Record<string, unknown> {
  return {
    startDate: '2026-08-16',
    endDate: '2026-08-22',
    asin: 'B000000001',
    searchQueryData: { searchQuery, searchQueryScore: 1, searchQueryVolume },
    impressionData: {
      totalQueryImpressionCount: 80,
      asinImpressionCount: 8,
      asinImpressionShare: 0.1,
    },
    clickData: { totalClickCount: 20, asinClickCount: 4, asinClickShare: 0.2 },
    cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 0.2 },
    purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 2, asinPurchaseShare: 0.4 },
  };
}
