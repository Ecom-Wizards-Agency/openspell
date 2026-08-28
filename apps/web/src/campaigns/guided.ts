/**
 * Browser-facing campaign recipes.
 *
 * These helpers only translate guided fields into the existing pure campaign
 * engine's inputs. Naming, fan-out, defaults, preflight, and UPDATE diffing
 * remain owned by `@wizard-ads/campaigns`.
 */
import {
  CAMPAIGN_TYPE_GOALS,
  DEFAULT_BID,
  DEFAULT_BUDGET,
  EW_NAMING_PRESET,
  generateCampaigns,
  looksLikeRealId,
  MAX_BID,
  MIN_BID,
  MIN_BUDGET,
  preflight,
  resolveNaming,
  resolveSpec,
  type CampaignBuildConfig,
  type CampaignType,
  type CampaignUpdateChanges,
} from '@wizard-ads/campaigns';

export interface CreateRecipe {
  id: CampaignType;
  label: string;
  description: string;
  inputLabel: string;
  inputHint: string;
}

export const CREATE_RECIPES: readonly CreateRecipe[] = [
  {
    id: 'SKW',
    label: 'Single keyword',
    description: 'One exact-match campaign per keyword.',
    inputLabel: 'Keywords',
    inputHint: 'One keyword per line. Each line becomes its own campaign.',
  },
  {
    id: 'Halo',
    label: 'Keyword group',
    description: 'Keep a focused exact-match keyword set together.',
    inputLabel: 'Keywords',
    inputHint: 'One keyword per line. The group stays in one campaign.',
  },
  {
    id: 'Phrase',
    label: 'Phrase discovery',
    description: 'Explore adjacent searches with phrase match.',
    inputLabel: 'Keywords',
    inputHint: 'One phrase per line.',
  },
  {
    id: 'Auto',
    label: 'Automatic',
    description: 'Create Amazon’s four automatic targeting groups.',
    inputLabel: 'Targets',
    inputHint: 'No keyword or product targets are needed for this recipe.',
  },
  {
    id: 'PAT',
    label: 'Product targets',
    description: 'Target specific products by ASIN.',
    inputLabel: 'Target ASINs',
    inputHint: 'One 10-character ASIN per line.',
  },
] as const;

export interface CreateGuideState {
  client: string;
  marketplace: string;
  recipe: CampaignType;
  goal: string;
  productName: string;
  targetDescriptor: string;
  sku: string;
  targets: string;
  dailyBudget: string;
  keywordBid: string;
  state: 'paused' | 'enabled';
  delimiter: string;
  suffix: string;
  variableOrder: string[];
}

export function defaultCreateGuide(client: string, marketplace: string): CreateGuideState {
  return {
    client,
    marketplace,
    recipe: 'Halo',
    goal: CAMPAIGN_TYPE_GOALS.Halo[0] ?? 'Profit',
    productName: '',
    targetDescriptor: '',
    sku: '',
    targets: '',
    dailyBudget: String(DEFAULT_BUDGET),
    keywordBid: String(DEFAULT_BID),
    state: 'paused',
    delimiter: EW_NAMING_PRESET.delimiter,
    suffix: EW_NAMING_PRESET.suffix,
    variableOrder: [...EW_NAMING_PRESET.variableOrder],
  };
}

export function selectCreateRecipe(
  state: CreateGuideState,
  recipe: CampaignType,
): CreateGuideState {
  return {
    ...state,
    recipe,
    goal: CAMPAIGN_TYPE_GOALS[recipe][0] ?? 'Discovery',
  };
}

function lines(value: string): string[] {
  return value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

function numeric(value: string): number {
  return Number(value.trim());
}

export function createConfigFromGuide(state: CreateGuideState): CampaignBuildConfig {
  const targets = lines(state.targets);
  const campaign = {
    campaignType: state.recipe,
    goal: state.goal,
    productName: state.productName.trim(),
    targetDescriptor: state.targetDescriptor.trim(),
    sku: lines(state.sku),
    ...(state.recipe === 'PAT'
      ? { targetAsins: targets }
      : state.recipe === 'Auto'
        ? {}
        : { keywords: targets }),
  };
  return {
    client: state.client,
    marketplace: state.marketplace,
    naming: resolveNaming({
      variableOrder: state.variableOrder,
      delimiter: state.delimiter,
      suffix: state.suffix,
    }),
    defaults: {
      dailyBudget: numeric(state.dailyBudget),
      keywordBid: numeric(state.keywordBid),
      state: state.state,
    },
    campaigns: [campaign],
  };
}

/** Live names use the engine's real resolution and fan-out logic. */
export function previewCreateNames(state: CreateGuideState, today: string): string[] {
  const config = createConfigFromGuide(state);
  const spec = resolveSpec(config.campaigns[0] ?? {}, config.defaults);
  return generateCampaigns(spec, config.naming, today).map((campaign) => campaign.campaignName);
}

export function validateCreateGuide(state: CreateGuideState, today: string): string[] {
  const issues: string[] = [];
  const budget = numeric(state.dailyBudget);
  const bid = numeric(state.keywordBid);
  if (!Number.isFinite(budget) || budget < MIN_BUDGET) {
    issues.push(`Daily budget must be at least ${MIN_BUDGET}.`);
  }
  if (!Number.isFinite(bid) || bid < MIN_BID || bid > MAX_BID) {
    issues.push(`Default bid must be between ${MIN_BID} and ${MAX_BID}.`);
  }
  if (state.variableOrder.length === 0) issues.push('Choose at least one naming token.');
  if (state.delimiter.length === 0) issues.push('Naming delimiter cannot be blank.');
  return [...issues, ...preflight(createConfigFromGuide(state), today).issues];
}

export type UpdateRecipeId =
  | 'campaign'
  | 'archive-campaigns'
  | 'ad-group'
  | 'replace-keyword'
  | 'add-keyword'
  | 'add-target';

export interface UpdateRecipe {
  id: UpdateRecipeId;
  label: string;
  description: string;
}

export const UPDATE_RECIPES: readonly UpdateRecipe[] = [
  { id: 'campaign', label: 'Campaign settings', description: 'Budget, name, bidding, state, or end date.' },
  { id: 'archive-campaigns', label: 'Archive campaigns', description: 'Archive one or more campaigns by Amazon ID.' },
  { id: 'ad-group', label: 'Ad group settings', description: 'Name, default bid, or state.' },
  { id: 'replace-keyword', label: 'Replace keyword', description: 'Archive the old keyword and create its replacement.' },
  { id: 'add-keyword', label: 'Add keyword', description: 'Add a keyword to an existing ad group.' },
  { id: 'add-target', label: 'Add product target', description: 'Add an ASIN target to an existing ad group.' },
] as const;

export interface UpdateGuideState {
  recipe: UpdateRecipeId;
  campaignId: string;
  adGroupId: string;
  entityId: string;
  ids: string;
  name: string;
  amount: string;
  text: string;
  matchType: string;
  biddingStrategy: string;
  state: string;
  endDate: string;
  clearEndDate: boolean;
  expanded: boolean;
}

export function defaultUpdateGuide(): UpdateGuideState {
  return {
    recipe: 'campaign',
    campaignId: '',
    adGroupId: '',
    entityId: '',
    ids: '',
    name: '',
    amount: '',
    text: '',
    matchType: '',
    biddingStrategy: '',
    state: '',
    endDate: '',
    clearEndDate: false,
    expanded: false,
  };
}

function optionalText(value: string): string | undefined {
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function optionalNumber(value: string): number | undefined {
  return value.trim().length === 0 ? undefined : Number(value);
}

export interface GuidedUpdateConfig {
  allowEndDateClear: boolean;
  changes: CampaignUpdateChanges;
}

export function updateConfigFromGuide(state: UpdateGuideState): GuidedUpdateConfig {
  let changes: CampaignUpdateChanges;
  switch (state.recipe) {
    case 'archive-campaigns':
      changes = { archiveCampaigns: lines(state.ids) };
      break;
    case 'ad-group':
      changes = {
        adGroups: [{
          adGroupId: state.adGroupId.trim(),
          name: optionalText(state.name),
          defaultBid: optionalNumber(state.amount),
          state: optionalText(state.state),
        }],
      };
      break;
    case 'replace-keyword':
      changes = {
        keywords: {
          replace: [{
            oldKeywordId: state.entityId.trim(),
            newText: optionalText(state.text),
            newMatchType: optionalText(state.matchType),
            newBid: optionalNumber(state.amount),
            state: optionalText(state.state),
          }],
        },
      };
      break;
    case 'add-keyword':
      changes = {
        keywords: {
          add: [{
            campaignId: state.campaignId.trim(),
            adGroupId: state.adGroupId.trim(),
            text: optionalText(state.text),
            matchType: optionalText(state.matchType),
            bid: optionalNumber(state.amount),
            state: optionalText(state.state),
          }],
        },
      };
      break;
    case 'add-target':
      changes = {
        targets: {
          add: [{
            campaignId: state.campaignId.trim(),
            adGroupId: state.adGroupId.trim(),
            asin: optionalText(state.text),
            expanded: state.expanded,
            bid: optionalNumber(state.amount),
            state: optionalText(state.state),
          }],
        },
      };
      break;
    case 'campaign':
      changes = {
        campaigns: [{
          campaignId: state.campaignId.trim(),
          name: optionalText(state.name),
          dailyBudget: optionalNumber(state.amount),
          biddingStrategy: optionalText(state.biddingStrategy),
          state: optionalText(state.state),
          endDate: optionalText(state.endDate),
          clearEndDate: state.clearEndDate,
        }],
      };
      break;
  }
  return { allowEndDateClear: state.clearEndDate, changes };
}

function requireId(value: string, label: string, issues: string[]): void {
  if (!looksLikeRealId(value)) issues.push(`${label} must be a numeric Amazon ID from the synced profile.`);
}

export function validateUpdateGuide(state: UpdateGuideState): string[] {
  const issues: string[] = [];
  const amount = optionalNumber(state.amount);
  if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) {
    issues.push('The amount must be a positive number.');
  }
  switch (state.recipe) {
    case 'archive-campaigns': {
      const ids = lines(state.ids);
      if (ids.length === 0) issues.push('Enter at least one campaign ID.');
      ids.forEach((id) => requireId(id, 'Campaign ID', issues));
      break;
    }
    case 'ad-group':
      requireId(state.adGroupId, 'Ad group ID', issues);
      if (!optionalText(state.name) && amount === undefined && !optionalText(state.state)) {
        issues.push('Choose at least one ad group change.');
      }
      break;
    case 'replace-keyword':
      requireId(state.entityId, 'Keyword ID', issues);
      if (!optionalText(state.text) && !optionalText(state.matchType) && amount === undefined) {
        issues.push('Enter replacement text, match type, or bid.');
      }
      break;
    case 'add-keyword':
      requireId(state.campaignId, 'Campaign ID', issues);
      requireId(state.adGroupId, 'Ad group ID', issues);
      if (!optionalText(state.text)) issues.push('Keyword text is required.');
      if (!optionalText(state.matchType)) issues.push('Match type is required.');
      break;
    case 'add-target':
      requireId(state.campaignId, 'Campaign ID', issues);
      requireId(state.adGroupId, 'Ad group ID', issues);
      if (!/^[A-Z0-9]{10}$/i.test(state.text.trim())) issues.push('Enter a 10-character target ASIN.');
      break;
    case 'campaign':
      requireId(state.campaignId, 'Campaign ID', issues);
      if (!optionalText(state.name) && amount === undefined && !optionalText(state.biddingStrategy)
        && !optionalText(state.state) && !optionalText(state.endDate) && !state.clearEndDate) {
        issues.push('Choose at least one campaign change.');
      }
      if (state.clearEndDate && state.endDate.trim().length > 0) {
        issues.push('Choose an end date or clear it, not both.');
      }
      break;
  }
  return [...new Set(issues)];
}
