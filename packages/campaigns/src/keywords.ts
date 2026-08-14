/**
 * Keyword research to campaign specs.
 *
 * The keyword workbook's "5. Campaign Structure" tab is a set of **buckets**:
 * rank keywords, shield keywords, a halo long-tail list, discovery roots, and
 * two competitor-ASIN lists. Each bucket has its own fan-out rule, and those
 * rules are the structure doctrine:
 *
 *   rank / shield keywords  one campaign per keyword (single-keyword campaigns)
 *   halo                    one campaign for the whole list, one root theme
 *   discovery roots         one campaign per root
 *   PAT lists               one campaign per list
 *
 * This package takes the buckets, not the spreadsheet: parsing XLSX belongs to
 * whatever hands the rows over, and keeping it out is what lets this stay a
 * pure function with a golden behind it.
 *
 * There is no BMM bucket. The reference has one, resolved from a column label;
 * generation dropped BMM on 2026-08-14, so discovery is Phrase only.
 */
import type { CampaignPurpose, CampaignType } from './constants.js';
import type { CampaignSpec, ProductList } from './types.js';

/** The buckets a keyword can land in. */
export const CAMPAIGN_BUCKETS = [
  'rank_skw',
  'shield_skw',
  'halo',
  'discovery_phrase',
  'shield_discovery_phrase',
  'pat_stronger',
  'pat_weaker',
] as const;
export type CampaignBucket = (typeof CAMPAIGN_BUCKETS)[number];

export interface BucketDefinition {
  campaignType: CampaignType;
  campaignPurpose: CampaignPurpose;
  /** What the bucket calls itself in a campaign name when it needs a label. */
  label: string;
  kind: 'keywords' | 'asins';
}

export const BUCKET_DEFINITIONS: Record<CampaignBucket, BucketDefinition> = {
  rank_skw: { campaignType: 'SKW', campaignPurpose: 'RANK_SKW', label: '', kind: 'keywords' },
  shield_skw: { campaignType: 'SKW', campaignPurpose: 'SHIELD', label: '', kind: 'keywords' },
  halo: { campaignType: 'Halo', campaignPurpose: 'HALO', label: 'Long-Tails', kind: 'keywords' },
  discovery_phrase: {
    campaignType: 'Phrase', campaignPurpose: 'DISCOVERY', label: 'Phrase Root', kind: 'keywords',
  },
  shield_discovery_phrase: {
    campaignType: 'Phrase', campaignPurpose: 'SHIELD', label: 'Phrase Brand', kind: 'keywords',
  },
  pat_stronger: { campaignType: 'PAT', campaignPurpose: 'DISCOVERY', label: 'Stronger', kind: 'asins' },
  pat_weaker: { campaignType: 'PAT', campaignPurpose: 'DISCOVERY', label: 'Weaker', kind: 'asins' },
};

/** One keyword out of research, with what the workbook knows about it. */
export interface KeywordRow {
  text: string;
  bucket: CampaignBucket;
  /** Monthly search volume, when research has one. Drives the band checks. */
  searchVolume?: number | null;
  /** Amazon's recommended bid, when research has one. Drives the start bid. */
  suggestedBid?: number | null;
}

/** One competitor ASIN out of research. */
export interface TargetRow {
  asin: string;
  bucket: 'pat_stronger' | 'pat_weaker';
  brand?: string;
  /** Estimated revenue, used only by the median/floor PAT split. */
  revenue?: number | null;
}

/**
 * One bucket's worth of rows, in the shape the reference's workbook scanner
 * emits: a type, a purpose, a column label, and pairs of values whose second
 * element is a search volume for keywords and a brand for ASINs.
 */
export interface KeywordSection {
  campaignType: string;
  campaignPurpose: string;
  label: string;
  kind: 'keywords' | 'asins';
  values: ReadonlyArray<readonly [string, string | number | null]>;
}

export interface SpecsFromSectionsOptions {
  productName?: string;
  sku?: readonly string[];
  asin?: readonly string[];
}

/**
 * Sections to campaign specs, one bucket's fan-out rule at a time.
 *
 * The ASIN branch upper-cases every target, because Amazon's targeting
 * expression is case-sensitive and research exports are not consistent.
 */
export function specsFromSections(
  sections: readonly KeywordSection[],
  options: SpecsFromSectionsOptions = {},
): CampaignSpec[] {
  const specs: CampaignSpec[] = [];
  for (const section of sections) {
    const base = {
      campaignType: section.campaignType,
      campaignPurpose: section.campaignPurpose,
      productName: options.productName ?? '',
      sku: [...(options.sku ?? [])] as ProductList,
      asin: [...(options.asin ?? [])] as ProductList,
    };
    if (section.kind === 'asins') {
      specs.push({
        ...base,
        targetAsins: section.values.map(([value]) => value.toUpperCase()),
        targetDescriptor: section.label,
      });
    } else if (section.campaignType === 'SKW') {
      for (const [keyword] of section.values) {
        specs.push({ ...base, keywords: [keyword], targetDescriptor: keyword });
      }
    } else if (section.campaignType === 'Halo') {
      specs.push({
        ...base,
        keywords: section.values.map(([keyword]) => keyword),
        targetDescriptor: section.label,
      });
    } else {
      // Discovery: one root keyword per campaign, so a root that works can be
      // scaled without dragging the rest of the list along.
      for (const [keyword] of section.values) {
        specs.push({ ...base, keywords: [keyword], targetDescriptor: keyword });
      }
    }
  }
  return specs;
}

/**
 * Keyword and target rows to sections, grouped by bucket.
 *
 * Bucket order follows `CAMPAIGN_BUCKETS`, not the order rows arrive in, so
 * the same research produces the same campaign order however it was collected.
 */
export function sectionsFromRows(
  keywordRows: readonly KeywordRow[],
  targetRows: readonly TargetRow[] = [],
): KeywordSection[] {
  const sections: KeywordSection[] = [];
  for (const bucket of CAMPAIGN_BUCKETS) {
    const definition = BUCKET_DEFINITIONS[bucket];
    const values: Array<readonly [string, string | number | null]> = definition.kind === 'asins'
      ? targetRows.filter((row) => row.bucket === bucket).map((row) => [row.asin, row.brand ?? ''] as const)
      : keywordRows.filter((row) => row.bucket === bucket).map((row) => [row.text, row.searchVolume ?? null] as const);
    if (values.length === 0) continue;
    sections.push({
      campaignType: definition.campaignType,
      campaignPurpose: definition.campaignPurpose,
      label: definition.label,
      kind: definition.kind,
      values,
    });
  }
  return sections;
}

/** The one-step path: research rows straight to campaign specs. */
export function specsFromRows(
  keywordRows: readonly KeywordRow[],
  targetRows: readonly TargetRow[] = [],
  options: SpecsFromSectionsOptions = {},
): CampaignSpec[] {
  return specsFromSections(sectionsFromRows(keywordRows, targetRows), options);
}
