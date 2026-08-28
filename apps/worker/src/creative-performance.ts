/**
 * Strict Sponsored Brands Video creative-ingestion seam.
 *
 * Amazon fetching is deliberately outside this module until a live-verified
 * ad-level report can supply ad, creative and Asset IDs together. This seam
 * accepts only normalized shared-contract values, refuses ambiguous joins,
 * persists ad-grain facts, and never attributes ad-group totals to an asset.
 */
import {
  AdCreativeAssetMapping,
  CreativeAsset,
  CreativeDailyFact,
  CreativeIngestionCounts,
  type CreativeAttributionState,
} from '@wizard-ads/shared';
import {
  persistCreativePerformanceBatch,
  type CreativeMappingWrite,
  type CreativePerformanceWriteBatch,
  type CreativePersistenceCounts,
  type DbHandle,
} from '@wizard-ads/db';

export interface CreativePerformanceSourceBatch {
  orgId: string;
  profileId: string;
  /** Raw asset records normalized by a verified asset-list adapter. */
  assets: readonly unknown[];
  /** Raw explicit ad -> creative -> asset mappings. */
  mappings: readonly unknown[];
  /** Raw ad-level daily facts. Ad-group totals are not accepted. */
  facts: readonly unknown[];
}

export interface CreativeRefusal {
  source: 'asset' | 'mapping' | 'fact';
  index: number;
  reason: string;
}

export interface StagedCreativePerformanceBatch {
  writeBatch: CreativePerformanceWriteBatch;
  counts: CreativeIngestionCounts;
  refusals: CreativeRefusal[];
}

export interface CreativePerformanceIngestionResult {
  counts: CreativeIngestionCounts;
  persistence: CreativePersistenceCounts;
  refusals: CreativeRefusal[];
}

export interface CreativePerformanceStore {
  persist(batch: CreativePerformanceWriteBatch): Promise<CreativePersistenceCounts>;
}

export class CreativePerformanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativePerformanceInputError';
  }
}

/**
 * Parse and reconcile a normalized source batch without touching the database.
 * Invalid rows remain visible as counted refusals; valid legacy/unsupported/
 * ambiguous/unmapped facts remain visible as separate attribution states.
 */
export function stageCreativePerformanceBatch(
  source: CreativePerformanceSourceBatch,
): StagedCreativePerformanceBatch {
  const refusals: CreativeRefusal[] = [];
  const assets = parseAssets(source, refusals);
  const mappings = parseMappings(source, refusals);
  const facts = parseFacts(source, mappings, refusals);

  const counts = CreativeIngestionCounts.parse({
    sourceAssets: source.assets.length,
    parsedRows: facts.length,
    mappedPlacements: mappings.filter(({ mapping }) => mapping.attributionState === 'mapped').length,
    unsupportedRows: facts.filter((fact) => fact.attributionState !== 'mapped').length,
    refusedRows: refusals.length,
    upserts: 0,
  });

  return {
    writeBatch: {
      orgId: source.orgId,
      profileId: source.profileId,
      assets,
      mappings,
      facts,
    },
    counts,
    refusals,
  };
}

/** Persist a staged batch and reconcile every returned upsert count. */
export async function ingestCreativePerformanceBatch(
  store: CreativePerformanceStore,
  source: CreativePerformanceSourceBatch,
): Promise<CreativePerformanceIngestionResult> {
  const staged = stageCreativePerformanceBatch(source);
  const persistence = await store.persist(staged.writeBatch);
  const expectedUpserts =
    staged.writeBatch.assets.length +
    staged.writeBatch.mappings.length +
    staged.writeBatch.facts.length;
  if (persistence.totalUpserts !== expectedUpserts) {
    throw new CreativePerformanceInputError(
      `creative batch expected ${expectedUpserts} upserts, received ${persistence.totalUpserts}`,
    );
  }
  return {
    counts: CreativeIngestionCounts.parse({
      ...staged.counts,
      upserts: persistence.totalUpserts,
    }),
    persistence,
    refusals: staged.refusals,
  };
}

export class DbCreativePerformanceStore implements CreativePerformanceStore {
  constructor(private readonly handle: DbHandle) {}

  persist(batch: CreativePerformanceWriteBatch): Promise<CreativePersistenceCounts> {
    return persistCreativePerformanceBatch(this.handle, batch);
  }
}

/**
 * Stable mapping identity across an asset revision. Asset ID is intentionally
 * absent so a later observed asset replaces the current mapping for the same
 * ad/creative/placement instead of leaving two mappings active.
 */
export function creativeMappingSourceKey(
  mapping: Pick<
    AdCreativeAssetMapping,
    'adProduct' | 'campaignId' | 'adGroupId' | 'adId' | 'creativeId' | 'placement'
  >,
): string {
  return JSON.stringify([
    mapping.adProduct,
    mapping.campaignId,
    mapping.adGroupId,
    mapping.adId,
    mapping.creativeId,
    mapping.placement,
  ]);
}

function parseAssets(
  source: CreativePerformanceSourceBatch,
  refusals: CreativeRefusal[],
): CreativeAsset[] {
  const accepted: CreativeAsset[] = [];
  const seen = new Set<string>();
  source.assets.forEach((raw, index) => {
    const parsed = CreativeAsset.safeParse(raw);
    if (!parsed.success) {
      refuse(refusals, 'asset', index, 'does not match the shared creative-asset contract');
      return;
    }
    const asset = parsed.data;
    if (asset.profileId !== source.profileId) {
      refuse(refusals, 'asset', index, 'belongs to another profile');
      return;
    }
    if (!asset.assetType.toLowerCase().includes('video')) {
      refuse(refusals, 'asset', index, 'is not a Sponsored Brands video asset');
      return;
    }
    if (seen.has(asset.assetId)) {
      refuse(refusals, 'asset', index, 'duplicates an Amazon Asset ID in this batch');
      return;
    }
    seen.add(asset.assetId);
    accepted.push(asset);
  });
  return accepted;
}

function parseMappings(
  source: CreativePerformanceSourceBatch,
  refusals: CreativeRefusal[],
): CreativeMappingWrite[] {
  const candidates: { index: number; mapping: AdCreativeAssetMapping; key: string }[] = [];
  source.mappings.forEach((raw, index) => {
    const parsed = AdCreativeAssetMapping.safeParse(raw);
    if (!parsed.success) {
      refuse(refusals, 'mapping', index, 'does not match the shared ad/creative/asset contract');
      return;
    }
    const mapping = parsed.data;
    const problem = attributionProblem(source.profileId, mapping, 'mapping');
    if (problem !== null) {
      refuse(refusals, 'mapping', index, problem);
      return;
    }
    candidates.push({ index, mapping, key: creativeMappingSourceKey(mapping) });
  });

  const countByKey = new Map<string, number>();
  for (const candidate of candidates) {
    countByKey.set(candidate.key, (countByKey.get(candidate.key) ?? 0) + 1);
  }
  const accepted: CreativeMappingWrite[] = [];
  for (const candidate of candidates) {
    if ((countByKey.get(candidate.key) ?? 0) > 1) {
      refuse(
        refusals,
        'mapping',
        candidate.index,
        'has multiple candidate assets; represent the source mapping as ambiguous',
      );
      continue;
    }
    accepted.push({ sourceMappingKey: candidate.key, mapping: candidate.mapping });
  }
  return accepted;
}

function parseFacts(
  source: CreativePerformanceSourceBatch,
  mappings: readonly CreativeMappingWrite[],
  refusals: CreativeRefusal[],
): CreativeDailyFact[] {
  const mappingByKey = new Map(mappings.map((mapping) => [mapping.sourceMappingKey, mapping.mapping]));
  const candidates: { index: number; fact: CreativeDailyFact; grain: string; adGrain: string }[] = [];
  source.facts.forEach((raw, index) => {
    const parsed = CreativeDailyFact.safeParse(raw);
    if (!parsed.success) {
      refuse(refusals, 'fact', index, 'does not match the shared ad-level creative fact contract');
      return;
    }
    const fact = parsed.data;
    const problem = attributionProblem(source.profileId, fact, 'fact');
    if (problem !== null) {
      refuse(refusals, 'fact', index, problem);
      return;
    }
    if (fact.clicks > fact.impressions) {
      refuse(refusals, 'fact', index, 'has more clicks than impressions');
      return;
    }
    const key = creativeMappingSourceKey(fact);
    const mapping = mappingByKey.get(key);
    if (mapping === undefined) {
      refuse(refusals, 'fact', index, 'has no explicit ad/creative/asset mapping');
      return;
    }
    if (
      mapping.assetId !== fact.assetId ||
      mapping.attributionState !== fact.attributionState
    ) {
      refuse(refusals, 'fact', index, 'disagrees with the explicit mapping identity or attribution state');
      return;
    }
    candidates.push({ index, fact, grain: factGrain(fact), adGrain: adFactGrain(fact) });
  });

  const grainCounts = occurrenceCounts(candidates.map((candidate) => candidate.grain));
  const adGrainCounts = occurrenceCounts(candidates.map((candidate) => candidate.adGrain));
  const accepted: CreativeDailyFact[] = [];
  for (const candidate of candidates) {
    if ((grainCounts.get(candidate.grain) ?? 0) > 1) {
      refuse(refusals, 'fact', candidate.index, 'duplicates an ad-level daily fact grain');
      continue;
    }
    if ((adGrainCounts.get(candidate.adGrain) ?? 0) > 1) {
      refuse(
        refusals,
        'fact',
        candidate.index,
        'would allocate one ad result to multiple creatives; retain one explicit ambiguous row instead',
      );
      continue;
    }
    accepted.push(candidate.fact);
  }
  return accepted;
}

function attributionProblem(
  profileId: string,
  row: {
    profileId: string;
    adProduct: string;
    creativeId: string | null;
    assetId: string | null;
    attributionState: CreativeAttributionState;
  },
  label: 'mapping' | 'fact',
): string | null {
  if (row.profileId !== profileId) return 'belongs to another profile';
  if (row.adProduct !== 'SB') return 'is not Sponsored Brands';
  if (row.attributionState === 'mapped') {
    if (row.creativeId === null) return `is a mapped ${label} without a creative ID`;
    if (row.assetId === null) return `is a mapped ${label} without an Amazon Asset ID`;
  } else if (row.assetId !== null) {
    return `must keep ${row.attributionState} attribution separate from an Asset ID`;
  }
  return null;
}

function factGrain(fact: CreativeDailyFact): string {
  return JSON.stringify([
    fact.profileId,
    fact.date,
    fact.adProduct,
    fact.campaignId,
    fact.adGroupId,
    fact.adId,
    fact.creativeId,
    fact.assetId,
    fact.placement,
  ]);
}

/** One performance row per ad/date/placement before any creative attribution. */
function adFactGrain(fact: CreativeDailyFact): string {
  return JSON.stringify([
    fact.profileId,
    fact.date,
    fact.adProduct,
    fact.campaignId,
    fact.adGroupId,
    fact.adId,
    fact.placement,
  ]);
}

function occurrenceCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function refuse(
  refusals: CreativeRefusal[],
  source: CreativeRefusal['source'],
  index: number,
  reason: string,
): void {
  refusals.push({ source, index, reason });
}
