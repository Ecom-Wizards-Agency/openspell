/**
 * Sponsored Products UPDATE mode.
 *
 * A desired change-set is diffed against the entity mirror and projected to
 * sparse Bulk Operations rows. The mirror is an argument, never an import:
 * this package remains pure and the database remains the only place that knows
 * how synced entities are loaded.
 *
 * This is intentionally separate from CREATE mode. A create row is a complete
 * declaration linked by temporary ids; an update row carries real Amazon ids
 * and only the fields the operator meant to change. Sharing a row builder
 * between those opposite blank-field semantics would make accidental clears
 * almost impossible to review.
 */
import type {
  CampaignRow as SyncedCampaign,
  EntityRow,
  KeywordRow as SyncedKeyword,
  NegativeRow as SyncedNegative,
  TargetExpression,
  TargetRow as SyncedTarget,
} from '@wizard-ads/shared';

import {
  AMAZON_BIDDING,
  AMAZON_MATCH,
  AMAZON_NEG_MATCH,
  PLACEMENT_LABELS,
  SP_COLUMNS,
  STATES,
  type MatchType,
  type NegativeMatchType,
  type PlacementKey,
} from './constants.js';
import type { BulkRow } from './types.js';
import { money } from './util.js';

export type AmazonIdInput = string | number;

export interface CampaignFieldUpdate {
  campaignId: AmazonIdInput;
  name?: string;
  dailyBudget?: number | null;
  biddingStrategy?: string;
  state?: string;
  endDate?: string;
  clearEndDate?: boolean;
  placements?: Partial<Record<PlacementKey, number | null>>;
}

export interface AdGroupFieldUpdate {
  adGroupId: AmazonIdInput;
  name?: string;
  defaultBid?: number | null;
  state?: string;
}

export interface EntityStateChanges {
  pause?: readonly AmazonIdInput[];
  enable?: readonly AmazonIdInput[];
}

export interface KeywordReplacement {
  oldKeywordId: AmazonIdInput;
  newText?: string;
  newMatchType?: string;
  newBid?: number | null;
  state?: string;
}

export interface KeywordAddition {
  campaignId: AmazonIdInput;
  adGroupId: AmazonIdInput;
  text?: string;
  matchType?: string;
  bid?: number | null;
  state?: string;
}

export interface KeywordChanges extends EntityStateChanges {
  archive?: readonly AmazonIdInput[];
  replace?: readonly KeywordReplacement[];
  add?: readonly KeywordAddition[];
}

export interface NegativeAddition {
  campaignId: AmazonIdInput;
  adGroupId?: AmazonIdInput;
  level?: string;
  text?: string;
  matchType?: string;
}

export interface NegativeChanges {
  enable?: readonly AmazonIdInput[];
  archive?: readonly AmazonIdInput[];
  add?: readonly NegativeAddition[];
}

export interface TargetAddition {
  campaignId: AmazonIdInput;
  adGroupId: AmazonIdInput;
  asin?: string;
  expanded?: boolean;
  bid?: number | null;
  state?: string;
}

export interface TargetChanges extends EntityStateChanges {
  archive?: readonly AmazonIdInput[];
  add?: readonly TargetAddition[];
}

/** The camelCase form of the reference UPDATE change-set. */
export interface CampaignUpdateChanges {
  archiveCampaigns?: readonly AmazonIdInput[];
  archiveAdGroups?: readonly AmazonIdInput[];
  campaigns?: readonly CampaignFieldUpdate[];
  adGroups?: readonly AdGroupFieldUpdate[];
  productAds?: EntityStateChanges;
  keywords?: KeywordChanges;
  negatives?: NegativeChanges;
  targets?: TargetChanges;
}

export interface CampaignUpdateOptions {
  /** Blank End Date clears a live end date, so both switches must be explicit. */
  allowEndDateClear?: boolean;
}

export interface CampaignUpdateResult {
  rows: BulkRow[];
  /** Applied and skipped operations, in the reference's plain-English form. */
  review: string[];
  /** Hard preflight failures. A caller must not export while this is non-empty. */
  errors: string[];
}

type ParentKind = 'Campaign' | 'Ad Group';
type ParentArchive = readonly [id: string, kind: ParentKind] | readonly [null, null];

interface EntityIndex {
  campaigns: Map<string, SyncedCampaign>;
  adGroups: Map<string, Extract<EntityRow, { entityType: 'ad_group' }>>;
  productAds: Map<string, Extract<EntityRow, { entityType: 'product_ad' }>>;
  keywords: Map<string, SyncedKeyword>;
  negatives: Map<string, SyncedNegative>;
  targets: Map<string, SyncedTarget>;
}

const MODEL_BIDDING: Readonly<Record<string, string>> = {
  legacy_for_sales: 'Dynamic bids - down only',
  auto_for_sales: 'Dynamic bids - up and down',
  manual: 'Fixed bid',
  rule_based: 'Rule-based bidding',
};

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Python keeps the `.0` on a float that happens to be whole in review text. */
function moneyText(value: number | null): string {
  if (value === null) return '';
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Amazon bulk ids are decimal strings. Temporary ids always contain punctuation or letters. */
export function looksLikeRealId(value: unknown): boolean {
  return /^\d+$/.test(stringValue(value));
}

function exportDate(value: unknown): string {
  const text = stringValue(value);
  if (!text) return '';
  if (/^\d{8}$/.test(text)) return text;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match === null ? text : `${match[1]}${match[2]}${match[3]}`;
}

function emptyRow(operation: 'Update' | 'Archive' | 'Create'): BulkRow {
  const row = Object.fromEntries(SP_COLUMNS.map((column) => [column, ''])) as BulkRow;
  row.Product = 'Sponsored Products';
  row.Operation = operation;
  return row;
}

function indexEntities(entities: readonly EntityRow[]): EntityIndex {
  const index: EntityIndex = {
    campaigns: new Map(),
    adGroups: new Map(),
    productAds: new Map(),
    keywords: new Map(),
    negatives: new Map(),
    targets: new Map(),
  };
  for (const entity of entities) {
    if (entity.adProduct !== 'SP') continue;
    switch (entity.entityType) {
      case 'campaign':
        index.campaigns.set(entity.amazonId, entity);
        break;
      case 'ad_group':
        index.adGroups.set(entity.amazonId, entity);
        break;
      case 'product_ad':
        index.productAds.set(entity.amazonId, entity);
        break;
      case 'keyword':
        index.keywords.set(entity.amazonId, entity);
        break;
      case 'negative':
        // The Python UPDATE reference has operations for negative keywords,
        // not negative product targets. The latter have no keyword text.
        if (entity.keywordText !== null) index.negatives.set(entity.amazonId, entity);
        break;
      case 'target':
        index.targets.set(entity.amazonId, entity);
        break;
      case 'portfolio':
        break;
    }
  }
  return index;
}

function campaignName(campaign: SyncedCampaign): string {
  return campaign.name ?? '';
}

function keywordMatchType(value: string): string {
  return value;
}

function expressionText(expression: readonly TargetExpression[], resolved: string | null): string {
  if (resolved) return resolved;
  return expression.map((clause) => {
    const value = clause.value;
    switch (clause.type) {
      case 'asin_same_as':
        return `asin="${value ?? ''}"`;
      case 'asin_expanded_from':
        return `asin-expanded="${value ?? ''}"`;
      case 'asin_brand_same_as':
        return `brand="${value ?? ''}"`;
      case 'asin_category_same_as':
        return `category="${value ?? ''}"`;
      case 'close_match':
        return 'close-match';
      case 'loose_match':
        return 'loose-match';
      default:
        return clause.type.replaceAll('_', '-');
    }
  }).join(' ');
}

function values<T>(value: readonly T[] | undefined): readonly T[] {
  return value ?? [];
}

/**
 * Diff an UPDATE change-set against one profile's synced Sponsored Products entities.
 *
 * The function returns errors instead of throwing for plan-level failures so a
 * preflight panel can show every bad id in one pass. Malformed JSON remains a
 * caller-boundary concern; this function expects the typed change-set above.
 */
export function buildCampaignUpdate(
  changes: CampaignUpdateChanges,
  entities: readonly EntityRow[],
  options: CampaignUpdateOptions = {},
): CampaignUpdateResult {
  const source = indexEntities(entities);
  const rows: BulkRow[] = [];
  const review: string[] = [];
  const errors: string[] = [];
  let counter = 0;
  const nextTempId = (): string => {
    counter += 1;
    return `new_${counter}`;
  };

  const archivedCampaigns = new Set(values(changes.archiveCampaigns).map(stringValue));
  for (const campaignId of archivedCampaigns) {
    if (!source.campaigns.has(campaignId)) {
      errors.push(`archive_campaigns: Campaign ID '${campaignId}' not found in the export`);
    }
  }

  const archivedAdGroups = new Set<string>();
  for (const adGroupId of new Set(values(changes.archiveAdGroups).map(stringValue))) {
    const adGroup = source.adGroups.get(adGroupId);
    if (adGroup === undefined) {
      errors.push(`archive_ad_groups: Ad Group ID '${adGroupId}' not found in the export`);
      continue;
    }
    if (archivedCampaigns.has(adGroup.campaignId)) {
      review.push(
        `SKIPPED (parent+child archive): Ad Group ${adGroupId}, because Campaign ${adGroup.campaignId} `
        + 'is already archived in this file; archiving a campaign cascades to '
        + 'its ad groups, so a separate Archive row for the child is redundant',
      );
      continue;
    }
    archivedAdGroups.add(adGroupId);
  }

  const parentArchived = (campaignId: string, adGroupId = ''): ParentArchive => {
    if (archivedCampaigns.has(campaignId)) return [campaignId, 'Campaign'];
    if (adGroupId && archivedAdGroups.has(adGroupId)) return [adGroupId, 'Ad Group'];
    return [null, null];
  };

  // Campaign updates.
  for (const change of values(changes.campaigns)) {
    const campaignId = stringValue(change.campaignId);
    if (!looksLikeRealId(campaignId)) {
      errors.push(
        `changes.campaigns: campaign_id '${campaignId}' is not a real bulksheets ID; `
        + 'Update/Archive rows must use IDs sourced from a bulksheets download, never a temp ID',
      );
      continue;
    }
    const current = source.campaigns.get(campaignId);
    if (current === undefined) {
      errors.push(`changes.campaigns: campaign_id '${campaignId}' not found in the loaded export`);
      continue;
    }
    if (archivedCampaigns.has(campaignId)) {
      review.push(
        `SKIPPED: Campaign ${campaignId} update (also archived in this file; the `
        + 'archive supersedes the update)',
      );
      continue;
    }

    const row = emptyRow('Update');
    row.Entity = 'Campaign';
    row['Campaign ID'] = campaignId;
    row['Campaign Name'] = campaignName(current);
    const changed = new Map<string, readonly [unknown, unknown]>();

    if (change.name) {
      row['Campaign Name'] = change.name;
      changed.set('Campaign Name', [campaignName(current), change.name]);
    }
    if (change.dailyBudget !== undefined && change.dailyBudget !== null) {
      const next = money(change.dailyBudget);
      if (stringValue(current.budgetAmount) !== stringValue(next)) {
        row['Daily Budget'] = next;
        changed.set('Daily Budget', [moneyText(current.budgetAmount), moneyText(next)]);
      }
    }
    if (change.biddingStrategy) {
      const next = AMAZON_BIDDING[change.biddingStrategy as keyof typeof AMAZON_BIDDING]
        ?? change.biddingStrategy;
      const currentLabel = current.biddingStrategy === null
        ? ''
        : (MODEL_BIDDING[current.biddingStrategy] ?? current.biddingStrategy);
      if (stringValue(currentLabel) !== stringValue(next)) {
        row['Bidding Strategy'] = next;
        changed.set('Bidding Strategy', [currentLabel, next]);
      }
    }
    if (change.state) {
      if (!(STATES as readonly string[]).includes(change.state)) {
        errors.push(`changes.campaigns/${campaignId}: state must be one of ${STATES.join('/')}`);
      } else if (stringValue(current.state) !== change.state) {
        row.State = change.state;
        changed.set('State', [current.state, change.state]);
      }
    }

    // Amazon silently removes a campaign from its portfolio when this cell is
    // omitted from an otherwise valid Campaign Update row.
    row['Portfolio ID'] = current.portfolioId ?? '';

    // End Date is the exceptional blank: it clears instead of preserving.
    const existingEndDate = exportDate(current.endDate);
    if (change.clearEndDate) {
      if (options.allowEndDateClear !== true) {
        errors.push(
          `changes.campaigns/${campaignId}: clear_end_date is set but the change-set's `
          + 'top-level allow_end_date_clear is false; blank End Date clears an existing end '
          + 'date, so clearing must be opted into explicitly',
        );
      } else {
        row['End Date'] = '';
        changed.set('End Date', [existingEndDate || '(none)', '(cleared, runs indefinitely)']);
      }
    } else if (change.endDate) {
      const next = exportDate(change.endDate);
      row['End Date'] = next;
      if (next !== existingEndDate) {
        changed.set('End Date', [existingEndDate || '(none)', next]);
      }
    } else {
      row['End Date'] = existingEndDate;
    }

    const placementRows: BulkRow[] = [];
    for (const key of Object.keys(PLACEMENT_LABELS) as PlacementKey[]) {
      const percentage = change.placements?.[key];
      if (percentage === undefined || percentage === null) continue;
      const placement = emptyRow('Update');
      placement.Entity = 'Bidding Adjustment';
      placement['Campaign ID'] = campaignId;
      placement['Campaign Name'] = campaignName(current);
      placement.Placement = PLACEMENT_LABELS[key];
      placement.Percentage = Math.trunc(percentage);
      placementRows.push(placement);
      changed.set(`Placement ${PLACEMENT_LABELS[key]}`, ['?', Math.trunc(percentage)]);
    }

    if (changed.size === 0 && placementRows.length === 0) {
      review.push(
        `SKIPPED (no-op): Campaign ${campaignId} (${campaignName(current)}) `
        + 'has no fields that differ from the export',
      );
      continue;
    }
    rows.push(row, ...placementRows);
    for (const [field, [oldValue, newValue]] of changed) {
      review.push(
        `UPDATE Campaign ${campaignId} (${campaignName(current)}): `
        + `${field} '${stringValue(oldValue)}' -> '${stringValue(newValue)}'`,
      );
    }
  }

  // Campaign archives cascade, so their children are suppressed below.
  for (const campaignId of archivedCampaigns) {
    const current = source.campaigns.get(campaignId);
    if (current === undefined) continue;
    const row = emptyRow('Archive');
    row.Entity = 'Campaign';
    row['Campaign ID'] = campaignId;
    row['Campaign Name'] = campaignName(current);
    rows.push(row);
    review.push(
      `ARCHIVE Campaign ${campaignId} (${row['Campaign Name']}); cascades to all of `
      + 'its Ad Groups, Keywords, Product Targeting, and Negatives',
    );
  }

  // Ad group updates.
  for (const change of values(changes.adGroups)) {
    const adGroupId = stringValue(change.adGroupId);
    if (!looksLikeRealId(adGroupId)) {
      errors.push(`changes.ad_groups: ad_group_id '${adGroupId}' is not a real ID`);
      continue;
    }
    const current = source.adGroups.get(adGroupId);
    if (current === undefined) {
      errors.push(`changes.ad_groups: ad_group_id '${adGroupId}' not found in the loaded export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(current.campaignId, adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): Ad Group ${adGroupId} update, because its `
        + `${parentKind} ${parent} is archived in this file`,
      );
      continue;
    }

    const row = emptyRow('Update');
    row.Entity = 'Ad Group';
    row['Campaign ID'] = current.campaignId;
    row['Ad Group ID'] = adGroupId;
    row['Ad Group Name'] = current.name ?? '';
    const changed = new Map<string, readonly [unknown, unknown]>();
    if (change.name) {
      row['Ad Group Name'] = change.name;
      changed.set('Ad Group Name', [current.name ?? '', change.name]);
    }
    if (change.defaultBid !== undefined && change.defaultBid !== null) {
      const next = money(change.defaultBid);
      if (stringValue(current.defaultBid) !== stringValue(next)) {
        row['Ad Group Default Bid'] = next;
        changed.set('Ad Group Default Bid', [moneyText(current.defaultBid), moneyText(next)]);
      }
    }
    if (change.state) {
      if (!(STATES as readonly string[]).includes(change.state)) {
        errors.push(`changes.ad_groups/${adGroupId}: state must be one of ${STATES.join('/')}`);
      } else if (stringValue(current.state) !== change.state) {
        row.State = change.state;
        changed.set('State', [current.state, change.state]);
      }
    }
    if (changed.size === 0) {
      review.push(
        `SKIPPED (no-op): Ad Group ${adGroupId} (${current.name ?? ''}) `
        + 'has no fields that differ from the export',
      );
      continue;
    }
    rows.push(row);
    for (const [field, [oldValue, newValue]] of changed) {
      review.push(
        `UPDATE Ad Group ${adGroupId} (${current.name ?? ''}): `
        + `${field} '${stringValue(oldValue)}' -> '${stringValue(newValue)}'`,
      );
    }
  }

  for (const adGroupId of archivedAdGroups) {
    const current = source.adGroups.get(adGroupId);
    if (current === undefined) continue;
    const row = emptyRow('Archive');
    row.Entity = 'Ad Group';
    row['Campaign ID'] = current.campaignId;
    row['Ad Group ID'] = adGroupId;
    row['Ad Group Name'] = current.name ?? '';
    rows.push(row);
    review.push(
      `ARCHIVE Ad Group ${adGroupId} (${row['Ad Group Name']}); cascades to its `
      + 'Keywords, Product Targeting, and Negatives',
    );
  }

  // Product ad state changes.
  for (const [action, targetState] of [['pause', 'paused'], ['enable', 'enabled']] as const) {
    for (const rawId of values(changes.productAds?.[action])) {
      const adId = stringValue(rawId);
      const current = source.productAds.get(adId);
      if (current === undefined) {
        errors.push(`product_ads.${action}: Ad ID '${adId}' not found in the export`);
        continue;
      }
      const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
      if (parent !== null) {
        review.push(
          `SKIPPED (parent archived): Product Ad ${adId} ${action}, because `
          + `its ${parentKind} ${parent} is archived in this file`,
        );
        continue;
      }
      if (current.state === targetState) {
        review.push(`SKIPPED (no-op): Product Ad ${adId} is already ${targetState}`);
        continue;
      }
      const row = emptyRow('Update');
      row.Entity = 'Product Ad';
      row['Campaign ID'] = current.campaignId;
      row['Ad Group ID'] = current.adGroupId;
      row['Ad ID'] = adId;
      row.State = targetState;
      rows.push(row);
      review.push(`UPDATE Product Ad ${adId}: State '${current.state}' -> '${targetState}'`);
    }
  }

  const keywordChanges = changes.keywords ?? {};
  for (const [action, targetState] of [['pause', 'paused'], ['enable', 'enabled']] as const) {
    for (const rawId of values(keywordChanges[action])) {
      const keywordId = stringValue(rawId);
      const current = source.keywords.get(keywordId);
      if (current === undefined) {
        errors.push(`keywords.${action}: Keyword ID '${keywordId}' not found in the export`);
        continue;
      }
      const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
      if (parent !== null) {
        review.push(
          `SKIPPED (parent archived): Keyword ${keywordId} ${action}, because its `
          + `${parentKind} ${parent} is archived in this file`,
        );
        continue;
      }
      if (current.state === targetState) {
        review.push(
          `SKIPPED (no-op): Keyword ${keywordId} (${current.keywordText}) is already ${targetState}`,
        );
        continue;
      }
      const row = emptyRow('Update');
      row.Entity = 'Keyword';
      row['Campaign ID'] = current.campaignId;
      row['Ad Group ID'] = current.adGroupId;
      row['Keyword ID'] = keywordId;
      row.State = targetState;
      rows.push(row);
      review.push(
        `UPDATE Keyword ${keywordId} (${current.keywordText}): State `
        + `'${current.state}' -> '${targetState}'`,
      );
    }
  }

  for (const keywordId of new Set(values(keywordChanges.archive).map(stringValue))) {
    const current = source.keywords.get(keywordId);
    if (current === undefined) {
      errors.push(`keywords.archive: Keyword ID '${keywordId}' not found in the export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): Keyword ${keywordId} archive, because its `
        + `${parentKind} ${parent} is already archived in this file`,
      );
      continue;
    }
    const row = emptyRow('Archive');
    row.Entity = 'Keyword';
    row['Campaign ID'] = current.campaignId;
    row['Ad Group ID'] = current.adGroupId;
    row['Keyword ID'] = keywordId;
    rows.push(row);
    review.push(
      `ARCHIVE Keyword ${keywordId} (${current.keywordText}, ${keywordMatchType(current.matchType)})`,
    );
  }

  // Keyword text and match type are immutable: replacement is archive + create.
  for (const replacement of values(keywordChanges.replace)) {
    const oldId = stringValue(replacement.oldKeywordId);
    const current = source.keywords.get(oldId);
    if (current === undefined) {
      errors.push(
        `keywords.replace: old_keyword_id '${oldId}' not found in the export`,
      );
      continue;
    }
    const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
    if (parent === null) {
      const archive = emptyRow('Archive');
      archive.Entity = 'Keyword';
      archive['Campaign ID'] = current.campaignId;
      archive['Ad Group ID'] = current.adGroupId;
      archive['Keyword ID'] = oldId;
      rows.push(archive);
    }
    const newText = replacement.newText || current.keywordText;
    const requestedMatch = replacement.newMatchType || '';
    const newMatch = (requestedMatch
      ? AMAZON_MATCH[requestedMatch as MatchType] ?? requestedMatch
      : '') || keywordMatchType(current.matchType);
    const newBid = replacement.newBid !== undefined && replacement.newBid !== null
      ? money(replacement.newBid)
      : (current.bid ?? '');
    const create = emptyRow('Create');
    create.Entity = 'Keyword';
    create['Campaign ID'] = current.campaignId;
    create['Ad Group ID'] = current.adGroupId;
    create['Keyword ID'] = nextTempId();
    create.State = replacement.state || current.state || 'enabled';
    create.Bid = newBid;
    create['Keyword Text'] = newText;
    create['Match Type'] = newMatch;
    rows.push(create);
    const note = parent === null
      ? ''
      : ` [archive of old ID skipped: parent ${parentKind} ${parent} already archived]`;
    review.push(
      `REPLACE Keyword ${oldId} (${current.keywordText}, ${keywordMatchType(current.matchType)}) `
      + `-> new Keyword '${newText}' (${newMatch}); Keyword Text/Match Type are immutable, `
      + `so this is Archive-old + Create-new, never an Update${note}`,
    );
  }

  for (const addition of values(keywordChanges.add)) {
    const campaignId = stringValue(addition.campaignId);
    const adGroupId = stringValue(addition.adGroupId);
    if (!looksLikeRealId(campaignId) || !source.campaigns.has(campaignId)) {
      errors.push(
        `keywords.add: campaign_id '${campaignId}' not found in the export; `
        + 'new keywords attach to an EXISTING (real-ID) campaign',
      );
      continue;
    }
    if (!looksLikeRealId(adGroupId) || !source.adGroups.has(adGroupId)) {
      errors.push(`keywords.add: ad_group_id '${adGroupId}' not found in the export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(campaignId, adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): new keyword '${addition.text ?? ''}', because `
        + `${parentKind} ${parent} is archived in this file`,
      );
      continue;
    }
    const row = emptyRow('Create');
    row.Entity = 'Keyword';
    row['Campaign ID'] = campaignId;
    row['Ad Group ID'] = adGroupId;
    row['Keyword ID'] = nextTempId();
    row.State = addition.state || 'enabled';
    if (addition.bid !== undefined && addition.bid !== null) row.Bid = money(addition.bid);
    row['Keyword Text'] = addition.text ?? '';
    const requestedMatch = addition.matchType ?? '';
    row['Match Type'] = AMAZON_MATCH[requestedMatch as MatchType] ?? requestedMatch;
    rows.push(row);
    review.push(
      `ADD Keyword '${addition.text ?? ''}' (${row['Match Type']}) to Ad Group `
      + `${adGroupId} (Campaign ${campaignId})`,
    );
  }

  const negativeChanges = changes.negatives ?? {};
  for (const rawId of values(negativeChanges.enable)) {
    const negativeId = stringValue(rawId);
    const current = source.negatives.get(negativeId);
    if (current === undefined) {
      errors.push(`negatives.enable: Negative Keyword ID '${negativeId}' not found in the export`);
      continue;
    }
    if (current.scope === 'campaign') {
      errors.push(
        `negatives.enable: Campaign Negative Keyword ${negativeId} cannot be `
        + 'state-updated; campaign-level negatives are archive-only',
      );
      continue;
    }
    const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId ?? '');
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): Negative ${negativeId} enable, because its `
        + `${parentKind} ${parent} is archived in this file`,
      );
      continue;
    }
    if (current.state === 'enabled') {
      review.push(
        `SKIPPED (no-op): Negative ${negativeId} (${current.keywordText ?? ''}) is already enabled`,
      );
      continue;
    }
    const row = emptyRow('Update');
    row.Entity = 'Negative Keyword';
    row['Campaign ID'] = current.campaignId;
    row['Ad Group ID'] = current.adGroupId ?? '';
    row['Keyword ID'] = negativeId;
    row.State = 'enabled';
    rows.push(row);
    review.push(
      `UPDATE Negative Keyword ${negativeId} (${current.keywordText ?? ''}): `
      + `State '${current.state}' -> 'enabled'`,
    );
  }

  for (const negativeId of new Set(values(negativeChanges.archive).map(stringValue))) {
    const current = source.negatives.get(negativeId);
    if (current === undefined) {
      errors.push(`negatives.archive: Negative Keyword ID '${negativeId}' not found in the export`);
      continue;
    }
    const adGroupId = current.adGroupId ?? '';
    const [parent, parentKind] = parentArchived(current.campaignId, adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): Negative ${negativeId} archive, because its `
        + `${parentKind} ${parent} is already archived in this file`,
      );
      continue;
    }
    const row = emptyRow('Archive');
    row.Entity = current.scope === 'campaign' ? 'Campaign Negative Keyword' : 'Negative Keyword';
    row['Campaign ID'] = current.campaignId;
    if (adGroupId) row['Ad Group ID'] = adGroupId;
    row['Keyword ID'] = negativeId;
    rows.push(row);
    review.push(
      `ARCHIVE Negative ${negativeId} (${current.keywordText ?? ''}); negatives `
      + 'can only be archived, never paused (reference 4.7)',
    );
  }

  for (const addition of values(negativeChanges.add)) {
    const campaignId = stringValue(addition.campaignId);
    const adGroupId = stringValue(addition.adGroupId);
    const level = addition.level || (adGroupId ? 'ad_group' : 'campaign');
    if (!looksLikeRealId(campaignId) || !source.campaigns.has(campaignId)) {
      errors.push(`negatives.add: campaign_id '${campaignId}' not found in the export`);
      continue;
    }
    if (level === 'ad_group' && (!looksLikeRealId(adGroupId) || !source.adGroups.has(adGroupId))) {
      errors.push(`negatives.add: ad_group_id '${adGroupId}' not found in the export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(campaignId, level === 'ad_group' ? adGroupId : '');
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): new negative '${addition.text ?? ''}', because `
        + `${parentKind} ${parent} is archived in this file`,
      );
      continue;
    }
    const row = emptyRow('Create');
    row.Entity = level === 'campaign' ? 'Campaign Negative Keyword' : 'Negative Keyword';
    row['Campaign ID'] = campaignId;
    if (level === 'ad_group') row['Ad Group ID'] = adGroupId;
    row['Keyword ID'] = nextTempId();
    row.State = 'enabled';
    row['Keyword Text'] = addition.text ?? '';
    const requestedMatch = addition.matchType ?? '';
    row['Match Type'] = AMAZON_NEG_MATCH[requestedMatch as NegativeMatchType] ?? requestedMatch;
    rows.push(row);
    review.push(
      `ADD Negative '${addition.text ?? ''}' (${row['Match Type']}) at ${level} `
      + `level (Campaign ${campaignId}${level === 'ad_group' ? `, Ad Group ${adGroupId}` : ''})`,
    );
  }

  const targetChanges = changes.targets ?? {};
  for (const [action, targetState] of [['pause', 'paused'], ['enable', 'enabled']] as const) {
    for (const rawId of values(targetChanges[action])) {
      const targetId = stringValue(rawId);
      const current = source.targets.get(targetId);
      if (current === undefined) {
        errors.push(`targets.${action}: Product Targeting ID '${targetId}' not found in the export`);
        continue;
      }
      const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
      if (parent !== null) {
        review.push(
          `SKIPPED (parent archived): Target ${targetId} ${action}, because its `
          + `${parentKind} ${parent} is archived in this file`,
        );
        continue;
      }
      const expression = expressionText(current.expression, current.resolvedExpression);
      if (current.state === targetState) {
        review.push(
          `SKIPPED (no-op): Target ${targetId} (${expression}) is already ${targetState}`,
        );
        continue;
      }
      const row = emptyRow('Update');
      row.Entity = 'Product Targeting';
      row['Campaign ID'] = current.campaignId;
      row['Ad Group ID'] = current.adGroupId;
      row['Product Targeting ID'] = targetId;
      row.State = targetState;
      rows.push(row);
      review.push(
        `UPDATE Product Targeting ${targetId} (${expression}): `
        + `State '${current.state}' -> '${targetState}'`,
      );
    }
  }

  for (const targetId of new Set(values(targetChanges.archive).map(stringValue))) {
    const current = source.targets.get(targetId);
    if (current === undefined) {
      errors.push(`targets.archive: Product Targeting ID '${targetId}' not found in the export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(current.campaignId, current.adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): Target ${targetId} archive, because its `
        + `${parentKind} ${parent} is already archived in this file`,
      );
      continue;
    }
    const expression = expressionText(current.expression, current.resolvedExpression);
    const row = emptyRow('Archive');
    row.Entity = 'Product Targeting';
    row['Campaign ID'] = current.campaignId;
    row['Ad Group ID'] = current.adGroupId;
    row['Product Targeting ID'] = targetId;
    rows.push(row);
    review.push(`ARCHIVE Product Targeting ${targetId} (${expression})`);
  }

  for (const addition of values(targetChanges.add)) {
    const campaignId = stringValue(addition.campaignId);
    const adGroupId = stringValue(addition.adGroupId);
    if (!looksLikeRealId(campaignId) || !source.campaigns.has(campaignId)) {
      errors.push(`targets.add: campaign_id '${campaignId}' not found in the export`);
      continue;
    }
    if (!looksLikeRealId(adGroupId) || !source.adGroups.has(adGroupId)) {
      errors.push(`targets.add: ad_group_id '${adGroupId}' not found in the export`);
      continue;
    }
    const [parent, parentKind] = parentArchived(campaignId, adGroupId);
    if (parent !== null) {
      review.push(
        `SKIPPED (parent archived): new target '${addition.asin ?? ''}', because `
        + `${parentKind} ${parent} is archived in this file`,
      );
      continue;
    }
    const asin = stringValue(addition.asin).toUpperCase();
    const expression = addition.expanded ? `asin-expanded="${asin}"` : `asin="${asin}"`;
    const row = emptyRow('Create');
    row.Entity = 'Product Targeting';
    row['Campaign ID'] = campaignId;
    row['Ad Group ID'] = adGroupId;
    row['Product Targeting ID'] = nextTempId();
    row.State = addition.state || 'enabled';
    if (addition.bid !== undefined && addition.bid !== null) row.Bid = money(addition.bid);
    row['Product Targeting Expression'] = expression;
    rows.push(row);
    review.push(
      `ADD Product Targeting ${expression} to Ad Group ${adGroupId} (Campaign ${campaignId})`,
    );
  }

  return { rows, review, errors };
}
