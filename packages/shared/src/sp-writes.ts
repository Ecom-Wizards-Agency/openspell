import { z } from 'zod';
import { BiddingStrategy } from './entities.js';
import {
  AmazonId,
  CurrencyCode,
  Region,
  Uuid,
} from './primitives.js';

export const SpWriteSchemaVersion = z.enum(['openspell.sp-write-plan.v1', 'openspell.sp-write-plan.v2']);
export type SpWriteSchemaVersion = z.infer<typeof SpWriteSchemaVersion>;

export const SpWriteSha256 = z.string().regex(/^[a-f0-9]{64}$/);
export type SpWriteSha256 = z.infer<typeof SpWriteSha256>;

const SpWriteUuid = Uuid.refine((value) => value === value.toLowerCase(), {
  message: 'SP write UUIDs must use lowercase canonical form',
});
const SpWriteInstant = z.iso.datetime();
const count = z.number().int().nonnegative();

export const SpCanonicalDecimal = z.string().regex(
  /^(?:0|[1-9]\d{0,11})(?:\.\d{0,5}[1-9])?$/,
  'expected a canonical nonnegative decimal with at most 12 integer and 6 fractional digits',
);
export type SpCanonicalDecimal = z.infer<typeof SpCanonicalDecimal>;

export const SpMoney = z.object({
  amount: SpCanonicalDecimal,
  currencyCode: CurrencyCode,
}).strict();
export type SpMoney = z.infer<typeof SpMoney>;

export const SpMutableState = z.enum(['enabled', 'paused']);
export type SpMutableState = z.infer<typeof SpMutableState>;

export const SpWriteProviderScope = z.object({
  amazonProfileId: AmazonId,
  connectionId: SpWriteUuid,
  region: Region,
  marketplaceId: AmazonId,
  currencyCode: CurrencyCode,
  apiDialect: z.literal('sp_v3'),
}).strict();
export type SpWriteProviderScope = z.infer<typeof SpWriteProviderScope>;

export const SpWriteRouteKey = z.enum([
  'sp.v3.campaigns.update',
  'sp.v3.ad_groups.update',
  'sp.v3.keywords.update',
  'sp.v3.targets.update',
  'sp.v3.product_ads.update',
]);
export type SpWriteRouteKey = z.infer<typeof SpWriteRouteKey>;

export const SpLogicalChangeKey = z.enum([
  'campaign.budget',
  'campaign.state',
  'campaign.placement.top_of_search',
  'campaign.placement.product_pages',
  'campaign.placement.rest_of_search',
  'campaign.placement.amazon_business',
  'ad_group.default_bid',
  'ad_group.state',
  'keyword.bid',
  'keyword.state',
  'target.bid',
  'target.state',
  'product_ad.state',
]);
export type SpLogicalChangeKey = z.infer<typeof SpLogicalChangeKey>;

export const SpPlacementKey = z.enum([
  'top_of_search',
  'product_pages',
  'rest_of_search',
  'amazon_business',
]);
export type SpPlacementKey = z.infer<typeof SpPlacementKey>;

const placementOrder: readonly SpPlacementKey[] = [
  'top_of_search',
  'product_pages',
  'rest_of_search',
  'amazon_business',
];

const SpPlacementPercentage = z.number().int().min(0).max(900);

const SpPlacementState = z.object({
  topOfSearch: SpPlacementPercentage.nullable(),
  productPages: SpPlacementPercentage.nullable(),
  restOfSearch: SpPlacementPercentage.nullable(),
  amazonBusiness: SpPlacementPercentage.nullable(),
}).strict();

export const SpShopperCohortAudienceSegment = z.object({
  audienceId: AmazonId,
  audienceSegmentType: z.string().trim().min(1).max(160),
}).strict();
export type SpShopperCohortAudienceSegment = z.infer<
  typeof SpShopperCohortAudienceSegment
>;

function audienceSegmentKey(value: SpShopperCohortAudienceSegment): string {
  return `${value.audienceSegmentType}:${value.audienceId}`;
}

function isCanonicalUniqueOrder<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  const keys = values.map(key);
  return new Set(keys).size === keys.length
    && keys.every((value, index) => index === 0 || (keys[index - 1] ?? '') < value);
}

export const SpShopperCohort = z.object({
  shopperCohortType: z.string().trim().min(1).max(160),
  percentage: SpPlacementPercentage,
  audienceSegments: z.array(SpShopperCohortAudienceSegment),
}).strict().superRefine((value, context) => {
  if (!isCanonicalUniqueOrder(value.audienceSegments, audienceSegmentKey)) {
    context.addIssue({
      code: 'custom',
      path: ['audienceSegments'],
      message: 'audience segments must be unique and in canonical order',
    });
  }
});
export type SpShopperCohort = z.infer<typeof SpShopperCohort>;

function shopperCohortKey(value: SpShopperCohort): string {
  return JSON.stringify([
    value.shopperCohortType,
    value.audienceSegments.map(audienceSegmentKey),
  ]);
}

export const SpCompleteCampaignBiddingState = z.object({
  strategy: BiddingStrategy,
  placements: SpPlacementState,
  shopperCohorts: z.array(SpShopperCohort),
  offAmazonBudgetControlStrategy: z.string().trim().min(1).max(160).nullable(),
}).strict().superRefine((value, context) => {
  if (!isCanonicalUniqueOrder(value.shopperCohorts, shopperCohortKey)) {
    context.addIssue({
      code: 'custom',
      path: ['shopperCohorts'],
      message: 'shopper cohorts must be unique and in canonical order',
    });
  }
});
export type SpCompleteCampaignBiddingState = z.infer<
  typeof SpCompleteCampaignBiddingState
>;

const SpMoneyChange = z.object({
  expected: SpMoney,
  requested: SpMoney,
}).strict().superRefine((value, context) => {
  if (value.expected.currencyCode !== value.requested.currencyCode) {
    context.addIssue({ code: 'custom', message: 'money change currency must stay fixed' });
  }
  if (value.expected.amount === value.requested.amount) {
    context.addIssue({ code: 'custom', message: 'money change must change the amount' });
  }
});

const SpStateChange = z.object({
  expected: SpMutableState,
  requested: SpMutableState,
}).strict().superRefine((value, context) => {
  if (value.expected === value.requested) {
    context.addIssue({ code: 'custom', message: 'state change must change the state' });
  }
});

function placementValue(
  state: SpCompleteCampaignBiddingState,
  key: SpPlacementKey,
): number | null {
  switch (key) {
    case 'top_of_search': return state.placements.topOfSearch;
    case 'product_pages': return state.placements.productPages;
    case 'rest_of_search': return state.placements.restOfSearch;
    case 'amazon_business': return state.placements.amazonBusiness;
  }
}

function placementChangeKey(key: SpPlacementKey): SpLogicalChangeKey {
  return `campaign.placement.${key}` as SpLogicalChangeKey;
}

export const SpPlacementChange = z.object({
  expected: SpCompleteCampaignBiddingState,
  requested: SpCompleteCampaignBiddingState,
  approvedPlacementKeys: z.array(SpPlacementKey).min(1).max(4),
}).strict().superRefine((value, context) => {
  const approved = value.approvedPlacementKeys;
  if (!isCanonicalUniqueOrder(approved, (item) => String(placementOrder.indexOf(item)).padStart(2, '0'))) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPlacementKeys'],
      message: 'approved placement keys must be unique and in canonical order',
    });
  }

  const actual = placementOrder.filter(
    (key) => placementValue(value.expected, key) !== placementValue(value.requested, key),
  );
  if (JSON.stringify(actual) !== JSON.stringify(approved)) {
    context.addIssue({
      code: 'custom',
      path: ['approvedPlacementKeys'],
      message: 'approved placement keys must equal the complete placement difference',
    });
  }

  if (value.expected.strategy !== value.requested.strategy
    || JSON.stringify(value.expected.shopperCohorts) !== JSON.stringify(value.requested.shopperCohorts)
    || value.expected.offAmazonBudgetControlStrategy
      !== value.requested.offAmazonBudgetControlStrategy) {
    context.addIssue({
      code: 'custom',
      message: 'placement writes must preserve strategy, shopper cohorts, and off-Amazon settings',
    });
  }
});
export type SpPlacementChange = z.infer<typeof SpPlacementChange>;

const SpForwardChangeSource = z.object({
  kind: z.literal('apply_row'),
  applyRowId: SpWriteUuid,
  changeKey: SpLogicalChangeKey,
}).strict();

const SpInverseChangeSource = z.object({
  kind: z.literal('inverse_action'),
  sourceActionId: SpWriteUuid,
  changeKey: SpLogicalChangeKey,
}).strict();

export const SpWriteChangeSource = z.discriminatedUnion('kind', [
  SpForwardChangeSource,
  SpInverseChangeSource,
]);
export type SpWriteChangeSource = z.infer<typeof SpWriteChangeSource>;

const actionBase = {
  actionId: SpWriteUuid,
  sources: z.array(SpWriteChangeSource).min(1).max(16),
  fingerprint: SpWriteSha256,
};

function requireNonemptyChanges(
  changes: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (Object.values(changes).every((value) => value === undefined)) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'write action changes cannot be empty' });
  }
}

const SpCampaignUpdateAction = z.object({
  ...actionBase,
  routeKey: z.literal('sp.v3.campaigns.update'),
  entity: z.object({ campaignId: AmazonId }).strict(),
  changes: z.object({
    budget: SpMoneyChange.optional(),
    state: SpStateChange.optional(),
    placement: SpPlacementChange.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireNonemptyChanges(value.changes, context));

const SpAdGroupUpdateAction = z.object({
  ...actionBase,
  routeKey: z.literal('sp.v3.ad_groups.update'),
  entity: z.object({ adGroupId: AmazonId }).strict(),
  changes: z.object({
    defaultBid: SpMoneyChange.optional(),
    state: SpStateChange.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireNonemptyChanges(value.changes, context));

const SpKeywordUpdateAction = z.object({
  ...actionBase,
  routeKey: z.literal('sp.v3.keywords.update'),
  entity: z.object({ keywordId: AmazonId }).strict(),
  changes: z.object({
    bid: SpMoneyChange.optional(),
    state: SpStateChange.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireNonemptyChanges(value.changes, context));

const SpTargetUpdateAction = z.object({
  ...actionBase,
  routeKey: z.literal('sp.v3.targets.update'),
  entity: z.object({ targetId: AmazonId }).strict(),
  changes: z.object({
    bid: SpMoneyChange.optional(),
    state: SpStateChange.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireNonemptyChanges(value.changes, context));

const SpProductAdUpdateAction = z.object({
  ...actionBase,
  routeKey: z.literal('sp.v3.product_ads.update'),
  entity: z.object({ productAdId: AmazonId }).strict(),
  changes: z.object({
    state: SpStateChange.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireNonemptyChanges(value.changes, context));

export const SpWriteAction = z.discriminatedUnion('routeKey', [
  SpCampaignUpdateAction,
  SpAdGroupUpdateAction,
  SpKeywordUpdateAction,
  SpTargetUpdateAction,
  SpProductAdUpdateAction,
]);
export type SpWriteAction = z.infer<typeof SpWriteAction>;

function entityIdForAction(action: SpWriteAction): string {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update': return action.entity.campaignId;
    case 'sp.v3.ad_groups.update': return action.entity.adGroupId;
    case 'sp.v3.keywords.update': return action.entity.keywordId;
    case 'sp.v3.targets.update': return action.entity.targetId;
    case 'sp.v3.product_ads.update': return action.entity.productAdId;
  }
}

function actionOrderKey(action: SpWriteAction): string {
  return `${action.routeKey}:${entityIdForAction(action)}:${action.actionId}`;
}

function changeKeysForAction(action: SpWriteAction): SpLogicalChangeKey[] {
  const keys: SpLogicalChangeKey[] = [];
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update':
      if (action.changes.budget !== undefined) keys.push('campaign.budget');
      if (action.changes.state !== undefined) keys.push('campaign.state');
      if (action.changes.placement !== undefined) {
        keys.push(...action.changes.placement.approvedPlacementKeys.map(placementChangeKey));
      }
      break;
    case 'sp.v3.ad_groups.update':
      if (action.changes.defaultBid !== undefined) keys.push('ad_group.default_bid');
      if (action.changes.state !== undefined) keys.push('ad_group.state');
      break;
    case 'sp.v3.keywords.update':
      if (action.changes.bid !== undefined) keys.push('keyword.bid');
      if (action.changes.state !== undefined) keys.push('keyword.state');
      break;
    case 'sp.v3.targets.update':
      if (action.changes.bid !== undefined) keys.push('target.bid');
      if (action.changes.state !== undefined) keys.push('target.state');
      break;
    case 'sp.v3.product_ads.update':
      if (action.changes.state !== undefined) keys.push('product_ad.state');
      break;
  }
  return keys.sort();
}

function sourceIdentity(source: SpWriteChangeSource): string {
  return source.kind === 'apply_row'
    ? `apply:${source.applyRowId}:${source.changeKey}`
    : `inverse:${source.sourceActionId}:${source.changeKey}`;
}

function actionSourceProblem(action: SpWriteAction): string | null {
  const actualKeys = action.sources.map((source) => source.changeKey);
  const expectedKeys = changeKeysForAction(action);
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    return 'action sources must account for every logical change exactly once';
  }
  if (new Set(action.sources.map(sourceIdentity)).size !== action.sources.length) {
    return 'action sources must be unique';
  }
  return null;
}

export function orderSpWriteActions(
  rawActions: readonly SpWriteAction[],
): SpWriteAction[] {
  return rawActions.map((action) => SpWriteAction.parse(action))
    .sort((left, right) => actionOrderKey(left).localeCompare(actionOrderKey(right)));
}

export function serializeSpWriteActionFingerprint(
  rawAction: SpWriteAction,
): string {
  const action = SpWriteAction.parse(rawAction);
  const { fingerprint: _fingerprint, ...preimage } = action;
  return JSON.stringify(['openspell.sp-write-action.v1', preimage]);
}

export const SpWriteRouteCounts = z.object({
  'sp.v3.campaigns.update': count,
  'sp.v3.ad_groups.update': count,
  'sp.v3.keywords.update': count,
  'sp.v3.targets.update': count,
  'sp.v3.product_ads.update': count,
}).strict();
export type SpWriteRouteCounts = z.infer<typeof SpWriteRouteCounts>;

export const SpWritePlanCounts = z.object({
  logicalChanges: z.number().int().positive(),
  providerRows: z.number().int().positive().max(500),
  uniqueEntities: z.number().int().positive().max(500),
  byRoute: SpWriteRouteCounts,
}).strict();
export type SpWritePlanCounts = z.infer<typeof SpWritePlanCounts>;

export const SpForwardWriteSource = z.object({
  kind: z.literal('apply_batch'),
  applyBatchId: SpWriteUuid,
  guardrailSnapshotFingerprint: SpWriteSha256,
  provenanceSnapshotFingerprint: SpWriteSha256,
}).strict();
export type SpForwardWriteSource = z.infer<typeof SpForwardWriteSource>;

export const SpInverseWriteSource = z.object({
  kind: z.literal('inverse_execution'),
  sourceExecutionId: SpWriteUuid,
  sourcePlanId: SpWriteUuid,
  sourcePlanFingerprint: SpWriteSha256,
}).strict();
export type SpInverseWriteSource = z.infer<typeof SpInverseWriteSource>;

export const SpWritePlanSource = z.discriminatedUnion('kind', [
  SpForwardWriteSource,
  SpInverseWriteSource,
]);
export type SpWritePlanSource = z.infer<typeof SpWritePlanSource>;

function emptyRouteCounts(): SpWriteRouteCounts {
  return {
    'sp.v3.campaigns.update': 0,
    'sp.v3.ad_groups.update': 0,
    'sp.v3.keywords.update': 0,
    'sp.v3.targets.update': 0,
    'sp.v3.product_ads.update': 0,
  };
}

function countsForActions(actions: readonly SpWriteAction[]): SpWritePlanCounts {
  const byRoute = emptyRouteCounts();
  for (const action of actions) byRoute[action.routeKey] += 1;
  return {
    logicalChanges: actions.reduce((sum, action) => sum + changeKeysForAction(action).length, 0),
    providerRows: actions.length,
    uniqueEntities: new Set(actions.map(actionOrderKeyWithoutActionId)).size,
    byRoute,
  };
}

function actionOrderKeyWithoutActionId(action: SpWriteAction): string {
  return `${action.routeKey}:${entityIdForAction(action)}`;
}

function actionMoneyValues(action: SpWriteAction): SpMoney[] {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update':
      return action.changes.budget === undefined
        ? []
        : [action.changes.budget.expected, action.changes.budget.requested];
    case 'sp.v3.ad_groups.update':
      return action.changes.defaultBid === undefined
        ? []
        : [action.changes.defaultBid.expected, action.changes.defaultBid.requested];
    case 'sp.v3.keywords.update':
    case 'sp.v3.targets.update':
      return action.changes.bid === undefined
        ? []
        : [action.changes.bid.expected, action.changes.bid.requested];
    case 'sp.v3.product_ads.update':
      return [];
  }
}

export const SpWritePlan = z.object({
  schemaVersion: SpWriteSchemaVersion,
  id: SpWriteUuid,
  orgId: SpWriteUuid,
  profileId: SpWriteUuid,
  providerScope: SpWriteProviderScope,
  direction: z.enum(['forward', 'inverse']),
  source: SpWritePlanSource,
  generatedAt: SpWriteInstant,
  frozenAt: SpWriteInstant,
  expiresAt: SpWriteInstant,
  actions: z.array(SpWriteAction).min(1).max(500),
  counts: SpWritePlanCounts,
  fingerprint: SpWriteSha256,
}).strict().superRefine((plan, context) => {
  if ((plan.direction === 'forward') !== (plan.source.kind === 'apply_batch')) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'plan direction and source disagree' });
  }
  if (Date.parse(plan.generatedAt) > Date.parse(plan.frozenAt)
    || Date.parse(plan.frozenAt) >= Date.parse(plan.expiresAt)) {
    context.addIssue({ code: 'custom', message: 'plan timestamps must be generated, frozen, then unexpired' });
  }
  if (plan.schemaVersion === 'openspell.sp-write-plan.v2'
    && [plan.generatedAt, plan.frozenAt, plan.expiresAt].some((at) => !/T\d{2}:\d{2}:\d{2}(?:[.]\d{1,6})?Z$/.test(at))) {
    context.addIssue({ code: 'custom', message: 'v2 plan timestamps permit at most six fractional digits' });
  }

  if (plan.schemaVersion === 'openspell.sp-write-plan.v1') {
    const ordered = orderSpWriteActions(plan.actions);
    if (JSON.stringify(ordered.map(actionOrderKey)) !== JSON.stringify(plan.actions.map(actionOrderKey))) {
      context.addIssue({ code: 'custom', path: ['actions'], message: 'plan actions must use canonical order' });
    }
  } else if (plan.actions.some((action) => action.routeKey !== 'sp.v3.keywords.update'
    || action.changes.bid === undefined || action.changes.state !== undefined
    || !SpKeywordBidDecimal.safeParse(action.changes.bid.expected.amount).success
    || !SpKeywordBidDecimal.safeParse(action.changes.bid.requested.amount).success
    || action.changes.bid.expected.amount === action.changes.bid.requested.amount
    || action.sources.length !== 1 || action.sources[0]?.changeKey !== 'keyword.bid')) {
    context.addIssue({ code: 'custom', path: ['actions'], message: 'v2 plans support keyword bids in source sequence only' });
  }
  if (new Set(plan.actions.map((action) => action.actionId)).size !== plan.actions.length) {
    context.addIssue({ code: 'custom', path: ['actions'], message: 'plan repeats an action ID' });
  }
  if (new Set(plan.actions.map(actionOrderKeyWithoutActionId)).size !== plan.actions.length) {
    context.addIssue({ code: 'custom', path: ['actions'], message: 'plan repeats a route and entity' });
  }

  const allSourceIdentities = new Set<string>();
  for (const [index, action] of plan.actions.entries()) {
    const sourceProblem = actionSourceProblem(action);
    if (sourceProblem !== null) {
      context.addIssue({
        code: 'custom',
        path: ['actions', index, 'sources'],
        message: sourceProblem,
      });
    }
    for (const source of action.sources) {
      if ((plan.direction === 'forward') !== (source.kind === 'apply_row')) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'sources'],
          message: 'action provenance does not match plan direction',
        });
      }
      const identity = sourceIdentity(source);
      if (allSourceIdentities.has(identity)) {
        context.addIssue({
          code: 'custom',
          path: ['actions', index, 'sources'],
          message: 'plan reuses one logical source',
        });
      }
      allSourceIdentities.add(identity);
    }
    if (actionMoneyValues(action).some(
      (money) => money.currencyCode !== plan.providerScope.currencyCode,
    )) {
      context.addIssue({
        code: 'custom',
        path: ['actions', index],
        message: 'action currency must match the provider scope',
      });
    }
  }

  if (JSON.stringify(countsForActions(plan.actions)) !== JSON.stringify(plan.counts)) {
    context.addIssue({ code: 'custom', path: ['counts'], message: 'plan counts differ from exact actions' });
  }
});
export type SpWritePlan = z.infer<typeof SpWritePlan>;

export type SpWriteSha256Hasher = {
  algorithm: 'sha256';
  digest(preimage: string): string;
};

function digestSha256(preimage: string, hasher: SpWriteSha256Hasher): SpWriteSha256 {
  if (hasher.algorithm !== 'sha256') throw new Error('SP write fingerprints require SHA-256');
  return SpWriteSha256.parse(hasher.digest(preimage));
}

export function serializeSpWritePlanFingerprint(rawPlan: SpWritePlan): string {
  const plan = SpWritePlan.parse(rawPlan);
  const { fingerprint: _fingerprint, ...preimage } = plan;
  return JSON.stringify([plan.schemaVersion, preimage]);
}

export function verifySpWritePlanFingerprints(
  rawPlan: unknown,
  hasher: SpWriteSha256Hasher,
): SpWritePlan {
  const plan = SpWritePlan.parse(rawPlan);
  for (const action of plan.actions) {
    const actual = digestSha256(serializeSpWriteActionFingerprint(action), hasher);
    if (actual !== action.fingerprint) throw new Error(`SP write action fingerprint mismatch: ${action.actionId}`);
  }
  const actualPlan = digestSha256(serializeSpWritePlanFingerprint(plan), hasher);
  if (actualPlan !== plan.fingerprint) throw new Error('SP write plan fingerprint mismatch');
  return plan;
}

function swappedChanges(forward: SpWriteAction, inverse: SpWriteAction): boolean {
  if (forward.routeKey !== inverse.routeKey
    || entityIdForAction(forward) !== entityIdForAction(inverse)) return false;

  const swap = (left: { expected: unknown; requested: unknown } | undefined,
    right: { expected: unknown; requested: unknown } | undefined): boolean => {
    if (left === undefined || right === undefined) return left === right;
    return JSON.stringify(left.expected) === JSON.stringify(right.requested)
      && JSON.stringify(left.requested) === JSON.stringify(right.expected);
  };

  switch (forward.routeKey) {
    case 'sp.v3.campaigns.update': {
      if (inverse.routeKey !== forward.routeKey) return false;
      const placement = forward.changes.placement;
      const inversePlacement = inverse.changes.placement;
      const placementSwapped = placement === undefined || inversePlacement === undefined
        ? placement === inversePlacement
        : JSON.stringify(placement.expected) === JSON.stringify(inversePlacement.requested)
          && JSON.stringify(placement.requested) === JSON.stringify(inversePlacement.expected)
          && JSON.stringify(placement.approvedPlacementKeys)
            === JSON.stringify(inversePlacement.approvedPlacementKeys);
      return swap(forward.changes.budget, inverse.changes.budget)
        && swap(forward.changes.state, inverse.changes.state)
        && placementSwapped;
    }
    case 'sp.v3.ad_groups.update':
      return inverse.routeKey === forward.routeKey
        && swap(forward.changes.defaultBid, inverse.changes.defaultBid)
        && swap(forward.changes.state, inverse.changes.state);
    case 'sp.v3.keywords.update':
      return inverse.routeKey === forward.routeKey
        && swap(forward.changes.bid, inverse.changes.bid)
        && swap(forward.changes.state, inverse.changes.state);
    case 'sp.v3.targets.update':
      return inverse.routeKey === forward.routeKey
        && swap(forward.changes.bid, inverse.changes.bid)
        && swap(forward.changes.state, inverse.changes.state);
    case 'sp.v3.product_ads.update':
      return inverse.routeKey === forward.routeKey
        && swap(forward.changes.state, inverse.changes.state);
  }
}

export function verifySpWriteInversePair(
  rawForward: unknown,
  rawInverse: unknown,
  hasher: SpWriteSha256Hasher,
): { forward: SpWritePlan; inverse: SpWritePlan } {
  const forward = verifySpWritePlanFingerprints(rawForward, hasher);
  const inverse = verifySpWritePlanFingerprints(rawInverse, hasher);
  if (forward.direction !== 'forward' || inverse.direction !== 'inverse'
    || inverse.source.kind !== 'inverse_execution') {
    throw new Error('SP write inverse pairing requires forward and inverse plans');
  }
  if (inverse.schemaVersion !== forward.schemaVersion
    || inverse.source.sourcePlanId !== forward.id
    || inverse.source.sourcePlanFingerprint !== forward.fingerprint
    || inverse.orgId !== forward.orgId
    || inverse.profileId !== forward.profileId
    || JSON.stringify(inverse.providerScope) !== JSON.stringify(forward.providerScope)
    || JSON.stringify(inverse.counts) !== JSON.stringify(forward.counts)) {
    throw new Error('SP write inverse plan scope or counts do not match the forward plan');
  }

  if (forward.schemaVersion === 'openspell.sp-write-plan.v2'
    && inverse.actions.some((action, index) => action.sources[0]?.kind !== 'inverse_action'
      || action.sources[0].sourceActionId !== forward.actions[index]?.actionId)) {
    throw new Error('SP write v2 inverse must preserve the forward source sequence');
  }

  const inverseBySource = new Map<string, SpWriteAction>();
  for (const action of inverse.actions) {
    const sourceIds = new Set(action.sources.map((source) => source.kind === 'inverse_action'
      ? source.sourceActionId
      : ''));
    if (sourceIds.size !== 1) throw new Error('SP write inverse action must point to one source action');
    const sourceId = [...sourceIds][0] ?? '';
    if (inverseBySource.has(sourceId)) throw new Error('SP write inverse repeats a source action');
    inverseBySource.set(sourceId, action);
  }
  if (inverseBySource.size !== forward.actions.length) {
    throw new Error('SP write inverse action count does not match the forward plan');
  }
  for (const action of forward.actions) {
    const inverseAction = inverseBySource.get(action.actionId);
    if (inverseAction === undefined || inverseAction.actionId === action.actionId
      || !swappedChanges(action, inverseAction)
      || JSON.stringify(changeKeysForAction(action)) !== JSON.stringify(changeKeysForAction(inverseAction))) {
      throw new Error(`SP write inverse does not exactly swap action ${action.actionId}`);
    }
  }
  return { forward, inverse };
}

export const SpWritePlanBinding = z.object({
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  orgId: SpWriteUuid,
  profileId: SpWriteUuid,
  providerScope: SpWriteProviderScope,
  direction: z.enum(['forward', 'inverse']),
  expiresAt: SpWriteInstant,
  counts: SpWritePlanCounts,
}).strict();
export type SpWritePlanBinding = z.infer<typeof SpWritePlanBinding>;

export function spWritePlanBinding(plan: SpWritePlan): SpWritePlanBinding {
  return SpWritePlanBinding.parse({
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    orgId: plan.orgId,
    profileId: plan.profileId,
    providerScope: plan.providerScope,
    direction: plan.direction,
    expiresAt: plan.expiresAt,
    counts: plan.counts,
  });
}

const SpWriteAuthorizedEntity = z.object({
  routeKey: SpWriteRouteKey,
  amazonEntityId: AmazonId,
  allowedChangeKeys: z.array(SpLogicalChangeKey).min(1).max(16),
  maxAbsoluteMoneyDelta: SpCanonicalDecimal.nullable(),
  maxAbsolutePlacementDelta: z.number().int().positive().max(900).nullable(),
}).strict().superRefine((value, context) => {
  const uniqueSorted = [...new Set(value.allowedChangeKeys)].sort();
  if (JSON.stringify(uniqueSorted) !== JSON.stringify(value.allowedChangeKeys)) {
    context.addIssue({
      code: 'custom',
      path: ['allowedChangeKeys'],
      message: 'allowed change keys must be unique and in canonical order',
    });
  }
  const routeKeys = routeChangeKeys(value.routeKey);
  if (value.allowedChangeKeys.some((key) => !routeKeys.includes(key))) {
    context.addIssue({ code: 'custom', path: ['allowedChangeKeys'], message: 'change key does not belong to route' });
  }
  const needsMoney = value.allowedChangeKeys.some(isMoneyChangeKey);
  const needsPlacement = value.allowedChangeKeys.some(isPlacementChangeKey);
  if (needsMoney !== (value.maxAbsoluteMoneyDelta !== null)) {
    context.addIssue({ code: 'custom', path: ['maxAbsoluteMoneyDelta'], message: 'money delta bound must match allowed money changes' });
  }
  if (needsPlacement !== (value.maxAbsolutePlacementDelta !== null)) {
    context.addIssue({ code: 'custom', path: ['maxAbsolutePlacementDelta'], message: 'placement delta bound must match allowed placement changes' });
  }
});

function routeChangeKeys(route: SpWriteRouteKey): SpLogicalChangeKey[] {
  switch (route) {
    case 'sp.v3.campaigns.update': return [
      'campaign.budget',
      'campaign.state',
      'campaign.placement.top_of_search',
      'campaign.placement.product_pages',
      'campaign.placement.rest_of_search',
      'campaign.placement.amazon_business',
    ];
    case 'sp.v3.ad_groups.update': return ['ad_group.default_bid', 'ad_group.state'];
    case 'sp.v3.keywords.update': return ['keyword.bid', 'keyword.state'];
    case 'sp.v3.targets.update': return ['target.bid', 'target.state'];
    case 'sp.v3.product_ads.update': return ['product_ad.state'];
  }
}

function isMoneyChangeKey(key: SpLogicalChangeKey): boolean {
  return ['campaign.budget', 'ad_group.default_bid', 'keyword.bid', 'target.bid'].includes(key);
}

function isPlacementChangeKey(key: SpLogicalChangeKey): boolean {
  return key.startsWith('campaign.placement.');
}

const SpWriteAuthorizedProfile = z.object({
  providerScope: SpWriteProviderScope,
  allowedEntities: z.array(SpWriteAuthorizedEntity).min(1).max(100),
}).strict().superRefine((value, context) => {
  const identities = value.allowedEntities.map(
    (entity) => `${entity.routeKey}:${entity.amazonEntityId}`,
  );
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', path: ['allowedEntities'], message: 'authorization repeats a route and entity' });
  }
});

const SpWriteBoundedConstraints = z.object({
  maxLogicalChangesPerPlan: z.number().int().positive().max(100),
  maxProviderRowsPerPlan: z.number().int().positive().max(100),
  maxConcurrentMutations: z.literal(1),
  maxCycles: z.literal(1),
  maxExecutions: z.literal(2),
  requireCurrentValueMatch: z.literal(true),
  requireForwardObservationBeforeInverse: z.literal(true),
  stopOnConflict: z.literal(true),
  disableAfterCycle: z.literal(true),
}).strict();

export const SpWriteBoundedAuthorization = z.object({
  schemaVersion: z.literal('openspell.sp-write-bounded-authorization.v1'),
  authorizationId: SpWriteUuid,
  issuedAt: SpWriteInstant,
  expiresAt: SpWriteInstant,
  profiles: z.array(SpWriteAuthorizedProfile).min(1).max(20),
  constraints: SpWriteBoundedConstraints,
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.issuedAt) >= Date.parse(value.expiresAt)) {
    context.addIssue({ code: 'custom', message: 'bounded authorization must expire after issue' });
  }
  const scopes = value.profiles.map((profile) => JSON.stringify(profile.providerScope));
  if (new Set(scopes).size !== scopes.length) {
    context.addIssue({ code: 'custom', path: ['profiles'], message: 'bounded authorization repeats a provider scope' });
  }
});
export type SpWriteBoundedAuthorization = z.infer<typeof SpWriteBoundedAuthorization>;

export const SpWriteBoundedAuthorizationBinding = z.object({
  authorizationId: SpWriteUuid,
  authorizationFingerprint: SpWriteSha256,
  expiresAt: SpWriteInstant,
}).strict();
export type SpWriteBoundedAuthorizationBinding = z.infer<
  typeof SpWriteBoundedAuthorizationBinding
>;

function sortedAuthorizationProfiles(
  profiles: readonly z.infer<typeof SpWriteAuthorizedProfile>[],
) {
  return profiles.map((profile) => ({
    ...profile,
    allowedEntities: [...profile.allowedEntities].sort((left, right) =>
      `${left.routeKey}:${left.amazonEntityId}`.localeCompare(`${right.routeKey}:${right.amazonEntityId}`)),
  })).sort((left, right) => JSON.stringify(left.providerScope).localeCompare(JSON.stringify(right.providerScope)));
}

export function serializeSpWriteBoundedAuthorizationFingerprint(
  rawAuthorization: SpWriteBoundedAuthorization,
): string {
  const authorization = SpWriteBoundedAuthorization.parse(rawAuthorization);
  const { fingerprint: _fingerprint, ...preimage } = authorization;
  return JSON.stringify([
    'openspell.sp-write-bounded-authorization.v1',
    { ...preimage, profiles: sortedAuthorizationProfiles(preimage.profiles) },
  ]);
}

export function verifySpWriteBoundedAuthorizationFingerprint(
  rawAuthorization: unknown,
  hasher: SpWriteSha256Hasher,
): SpWriteBoundedAuthorization {
  const authorization = SpWriteBoundedAuthorization.parse(rawAuthorization);
  const actual = digestSha256(
    serializeSpWriteBoundedAuthorizationFingerprint(authorization),
    hasher,
  );
  if (actual !== authorization.fingerprint) {
    throw new Error('SP write bounded authorization fingerprint mismatch');
  }
  return authorization;
}

function decimalParts(value: SpCanonicalDecimal): { coefficient: bigint; scale: number } {
  const [integer, fractional = ''] = value.split('.');
  return { coefficient: BigInt(`${integer}${fractional}`), scale: fractional.length };
}

function decimalDeltaWithin(
  left: SpCanonicalDecimal,
  right: SpCanonicalDecimal,
  maximum: SpCanonicalDecimal,
): boolean {
  const values = [left, right, maximum].map(decimalParts);
  const scale = Math.max(...values.map((value) => value.scale));
  const normalize = (value: { coefficient: bigint; scale: number }): bigint =>
    value.coefficient * (10n ** BigInt(scale - value.scale));
  const difference = normalize(values[0]!) >= normalize(values[1]!)
    ? normalize(values[0]!) - normalize(values[1]!)
    : normalize(values[1]!) - normalize(values[0]!);
  return difference <= normalize(values[2]!);
}

function moneyChangeForKey(
  action: SpWriteAction,
  key: SpLogicalChangeKey,
): { expected: SpMoney; requested: SpMoney } | undefined {
  switch (key) {
    case 'campaign.budget': return action.routeKey === 'sp.v3.campaigns.update' ? action.changes.budget : undefined;
    case 'ad_group.default_bid': return action.routeKey === 'sp.v3.ad_groups.update' ? action.changes.defaultBid : undefined;
    case 'keyword.bid': return action.routeKey === 'sp.v3.keywords.update' ? action.changes.bid : undefined;
    case 'target.bid': return action.routeKey === 'sp.v3.targets.update' ? action.changes.bid : undefined;
    default: return undefined;
  }
}

function verifyPlanWithinBoundedAuthorization(
  plan: SpWritePlan,
  authorization: SpWriteBoundedAuthorization,
): void {
  const profile = authorization.profiles.find(
    (candidate) => JSON.stringify(candidate.providerScope) === JSON.stringify(plan.providerScope),
  );
  if (profile === undefined) throw new Error('SP write plan provider scope is not authorized');
  if (plan.counts.logicalChanges > authorization.constraints.maxLogicalChangesPerPlan
    || plan.counts.providerRows > authorization.constraints.maxProviderRowsPerPlan) {
    throw new Error('SP write plan exceeds bounded authorization counts');
  }

  for (const action of plan.actions) {
    const allowed = profile.allowedEntities.find(
      (entity) => entity.routeKey === action.routeKey
        && entity.amazonEntityId === entityIdForAction(action),
    );
    if (allowed === undefined) throw new Error(`SP write action is not authorized: ${action.actionId}`);
    const keys = changeKeysForAction(action);
    if (keys.some((key) => !allowed.allowedChangeKeys.includes(key))) {
      throw new Error(`SP write action change is not authorized: ${action.actionId}`);
    }
    for (const key of keys.filter(isMoneyChangeKey)) {
      const change = moneyChangeForKey(action, key);
      if (change === undefined || allowed.maxAbsoluteMoneyDelta === null
        || !decimalDeltaWithin(change.expected.amount, change.requested.amount, allowed.maxAbsoluteMoneyDelta)) {
        throw new Error(`SP write money delta exceeds authorization: ${action.actionId}`);
      }
    }
    if (action.routeKey === 'sp.v3.campaigns.update'
      && action.changes.placement !== undefined) {
      if (allowed.maxAbsolutePlacementDelta === null) {
        throw new Error(`SP write placement delta is not authorized: ${action.actionId}`);
      }
      for (const key of action.changes.placement.approvedPlacementKeys) {
        const expected = placementValue(action.changes.placement.expected, key);
        const requested = placementValue(action.changes.placement.requested, key);
        if (expected === null || requested === null
          || Math.abs(expected - requested) > allowed.maxAbsolutePlacementDelta) {
          throw new Error(`SP write placement delta exceeds authorization: ${action.actionId}`);
        }
      }
    }
  }
}

export const SpWriteConfirmationVersion = z.literal(
  'openspell.amazon-sp-write-confirmation.v1',
);
export type SpWriteConfirmationVersion = z.infer<typeof SpWriteConfirmationVersion>;

export const SpWriteApprovalMode = z.enum(['manual', 'bounded_live_test']);
export type SpWriteApprovalMode = z.infer<typeof SpWriteApprovalMode>;

export const ApproveSpWritePlan = z.object({
  approvalRequestId: SpWriteUuid,
  plan: SpWritePlanBinding,
  approvalMode: SpWriteApprovalMode,
  confirmationVersion: SpWriteConfirmationVersion,
  boundedAuthorization: SpWriteBoundedAuthorizationBinding.nullable(),
  preapprovedInversePlan: SpWritePlanBinding.nullable(),
}).strict().superRefine((value, context) => {
  const bounded = value.approvalMode === 'bounded_live_test';
  if (bounded !== (value.boundedAuthorization !== null)
    || bounded !== (value.preapprovedInversePlan !== null)) {
    context.addIssue({
      code: 'custom',
      message: 'bounded approval requires exact authorization and inverse bindings; manual approval forbids them',
    });
  }
  if (bounded && value.plan.direction !== 'forward') {
    context.addIssue({ code: 'custom', path: ['plan', 'direction'], message: 'bounded approval starts with a forward plan' });
  }
});
export type ApproveSpWritePlan = z.infer<typeof ApproveSpWritePlan>;

export type VerifiedSpWriteApprovalArtifacts = {
  plan: SpWritePlan;
  inverse: SpWritePlan | null;
  request: ApproveSpWritePlan;
  boundedAuthorization: SpWriteBoundedAuthorization | null;
};

export function verifySpWriteApprovalArtifacts(
  rawPlan: unknown,
  rawInverse: unknown | null,
  rawRequest: unknown,
  rawBoundedAuthorization: unknown | null,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteApprovalArtifacts {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const request = ApproveSpWritePlan.parse(rawRequest);
  const now = SpWriteInstant.parse(rawNow);
  if (JSON.stringify(request.plan) !== JSON.stringify(spWritePlanBinding(plan))) {
    throw new Error('SP write approval request does not match the plan');
  }
  if (Date.parse(now) >= Date.parse(plan.expiresAt)) throw new Error('SP write plan is expired');

  if (request.approvalMode === 'manual') {
    if (rawInverse !== null || rawBoundedAuthorization !== null) {
      throw new Error('manual SP write approval cannot preauthorize an inverse');
    }
    return { plan, inverse: null, request, boundedAuthorization: null };
  }

  if (rawInverse === null || rawBoundedAuthorization === null
    || request.preapprovedInversePlan === null || request.boundedAuthorization === null) {
    throw new Error('bounded SP write approval requires an exact inverse and authorization');
  }
  const { inverse } = verifySpWriteInversePair(plan, rawInverse, hasher);
  const boundedAuthorization = verifySpWriteBoundedAuthorizationFingerprint(
    rawBoundedAuthorization,
    hasher,
  );
  const authorizationBinding: SpWriteBoundedAuthorizationBinding = {
    authorizationId: boundedAuthorization.authorizationId,
    authorizationFingerprint: boundedAuthorization.fingerprint,
    expiresAt: boundedAuthorization.expiresAt,
  };
  if (JSON.stringify(request.preapprovedInversePlan) !== JSON.stringify(spWritePlanBinding(inverse))
    || JSON.stringify(request.boundedAuthorization) !== JSON.stringify(authorizationBinding)) {
    throw new Error('bounded SP write approval binding mismatch');
  }
  if (Date.parse(now) < Date.parse(boundedAuthorization.issuedAt)
    || Date.parse(now) >= Date.parse(boundedAuthorization.expiresAt)
    || Date.parse(plan.expiresAt) > Date.parse(boundedAuthorization.expiresAt)
    || Date.parse(inverse.expiresAt) > Date.parse(boundedAuthorization.expiresAt)) {
    throw new Error('bounded SP write authorization is not current for both plans');
  }
  verifyPlanWithinBoundedAuthorization(plan, boundedAuthorization);
  return { plan, inverse, request, boundedAuthorization };
}

export const SpWriteGateSnapshot = z.object({
  environmentGate: z.literal('enabled'),
  environmentGateVersion: SpWriteUuid,
  profileGrantId: SpWriteUuid,
  profileGrantVersion: SpWriteUuid,
  gateSnapshotFingerprint: SpWriteSha256,
  checkedAt: SpWriteInstant,
}).strict();
export type SpWriteGateSnapshot = z.infer<typeof SpWriteGateSnapshot>;

export const SpHumanAuthorizationReceiptV1 = z.object({
  schemaVersion: z.literal('openspell.sp-write-authorization-receipt.v1'),
  approvalId: SpWriteUuid,
  approvalRequestId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  approvalMode: SpWriteApprovalMode,
  plan: SpWritePlanBinding,
  preapprovedInversePlan: SpWritePlanBinding.nullable(),
  boundedAuthorization: SpWriteBoundedAuthorizationBinding.nullable(),
  approvedBy: SpWriteUuid,
  approvedAt: SpWriteInstant,
  expiresAt: SpWriteInstant,
  confirmationVersion: SpWriteConfirmationVersion,
  gateSnapshot: SpWriteGateSnapshot,
}).strict().superRefine((value, context) => {
  const bounded = value.approvalMode === 'bounded_live_test';
  if (bounded !== (value.preapprovedInversePlan !== null)
    || bounded !== (value.boundedAuthorization !== null)) {
    context.addIssue({ code: 'custom', message: 'receipt mode and bounded bindings disagree' });
  }
  if (bounded && value.plan.direction !== 'forward') {
    context.addIssue({ code: 'custom', path: ['plan', 'direction'], message: 'bounded receipt must start with a forward plan' });
  }
  if (Date.parse(value.gateSnapshot.checkedAt) > Date.parse(value.approvedAt)
    || Date.parse(value.approvedAt) >= Date.parse(value.expiresAt)
    || Date.parse(value.expiresAt) > Date.parse(value.plan.expiresAt)
    || (value.preapprovedInversePlan !== null
      && Date.parse(value.expiresAt) > Date.parse(value.preapprovedInversePlan.expiresAt))
    || (value.boundedAuthorization !== null
      && Date.parse(value.expiresAt) > Date.parse(value.boundedAuthorization.expiresAt))) {
    context.addIssue({ code: 'custom', message: 'receipt timestamps exceed their authority window' });
  }
});
export type SpHumanAuthorizationReceiptV1 = z.infer<typeof SpHumanAuthorizationReceiptV1>;

/** Persisted modes include delegation; human confirmation input stays unchanged. */
export const SpWriteExecutionApprovalMode = z.enum([...SpWriteApprovalMode.options, 'delegated_mcp']);

/** Positive bid representable by the existing numeric(12,4) keyword mirror. */
export const SpKeywordBidDecimal = SpCanonicalDecimal.refine((value) => {
  const [whole, fraction = ''] = value.split('.');
  return value !== '0' && whole!.length <= 8 && fraction.length <= 4;
}, 'bid must fit the keyword mirror without rounding');

export const McpKeywordBidProposal = z.object({
  keywordId: AmazonId, expectedBid: SpKeywordBidDecimal, requestedBid: SpKeywordBidDecimal,
}).strict().refine((value) => value.expectedBid !== value.requestedBid, 'a proposal must change the bid');
export type McpKeywordBidProposal = z.infer<typeof McpKeywordBidProposal>;

export const McpBidLimits = z.object({
  action: z.literal('keyword.bid'),
  maximumRowsPerCall: z.number().int().min(1).max(500),
  maximumRowsPerUtcDay: z.number().int().min(1).max(2_147_483_647),
  maximumAbsoluteDeltaByCurrency: z.array(SpMoney.refine((money) => money.amount !== '0',
    'absolute delta must be positive')).min(1),
  /** Ratio, not a percentage: a value of one permits a change equal to the old bid. */
  maximumRelativeDelta: SpCanonicalDecimal.refine((value) => value !== '0', 'relative delta must be positive'),
}).strict().superRefine((value, context) => {
  if (value.maximumRowsPerCall > value.maximumRowsPerUtcDay
    || !isCanonicalUniqueOrder(value.maximumAbsoluteDeltaByCurrency, (money) => money.currencyCode)) {
    context.addIssue({ code: 'custom', message: 'limits require sufficient daily capacity and unique sorted currencies' });
  }
});
export type McpBidLimits = z.infer<typeof McpBidLimits>;

export const McpWriteDelegation = z.object({
  schemaVersion: z.literal('openspell.mcp-write-delegation.v1'),
  versionId: SpWriteUuid,
  keyId: SpWriteUuid,
  keyLabel: z.string().trim().min(1).max(160),
  orgId: SpWriteUuid,
  issuerUserId: SpWriteUuid,
  profiles: z.array(z.object({ profileId: SpWriteUuid, currencyCode: CurrencyCode }).strict()).min(1),
  issuedAt: SpWriteInstant,
  expiresAt: SpWriteInstant,
  limits: McpBidLimits,
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  const currencies = [...new Set(value.profiles.map((profile) => profile.currencyCode))].sort();
  if (lifetime <= 0 || lifetime > 90 * 86_400_000
    || !isCanonicalUniqueOrder(value.profiles, (profile) => profile.profileId)
    || JSON.stringify(currencies) !== JSON.stringify(value.limits.maximumAbsoluteDeltaByCurrency.map((money) => money.currencyCode))) {
    context.addIssue({ code: 'custom', message: 'delegation requires bounded expiry, unique sorted profiles and exact currency limits' });
  }
});
export type McpWriteDelegation = z.infer<typeof McpWriteDelegation>;

export function serializeMcpWriteDelegationFingerprint(raw: McpWriteDelegation): string {
  const { fingerprint: _fingerprint, ...authority } = McpWriteDelegation.parse(raw);
  return JSON.stringify(['openspell.mcp-write-delegation-fingerprint.v1', authority]);
}

export function verifyMcpWriteDelegationFingerprint(raw: unknown, hasher: SpWriteSha256Hasher): McpWriteDelegation {
  const delegation = McpWriteDelegation.parse(raw);
  if (digestSha256(serializeMcpWriteDelegationFingerprint(delegation), hasher) !== delegation.fingerprint) {
    throw new Error('MCP write delegation fingerprint mismatch');
  }
  return delegation;
}

export const McpWriteReservation = z.object({
  id: SpWriteUuid,
  day: z.iso.date(),
  rows: z.number().int().min(1).max(500),
  /** V1 charges every admitted row, including refused or ambiguous execution. */
  releasedRows: z.literal(0),
}).strict();
export type McpWriteReservation = z.infer<typeof McpWriteReservation>;

export const SpDelegatedAuthorizationReceiptV2 = z.object({
  schemaVersion: z.literal('openspell.sp-write-authorization-receipt.v2'),
  approvalId: SpWriteUuid,
  approvalRequestId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  approvalMode: z.literal('delegated_mcp'),
  plan: SpWritePlanBinding,
  preapprovedInversePlan: z.null(),
  boundedAuthorization: z.null(),
  /** Delegation issuer; this does not claim the user confirmed this individual batch. */
  approvedBy: SpWriteUuid,
  /** Database admission time for this plan under its delegation. */
  approvedAt: SpWriteInstant,
  expiresAt: SpWriteInstant,
  confirmationVersion: z.literal('openspell.mcp-delegated-bid-admission.v1'),
  gateSnapshot: SpWriteGateSnapshot,
  mcpGate: z.object({ versionId: SpWriteUuid, enabled: z.literal(true), checkedAt: SpWriteInstant }).strict(),
  delegation: McpWriteDelegation,
  reservation: McpWriteReservation,
}).strict().superRefine((value, context) => {
  const d = value.delegation;
  const p = value.plan;
  if (value.approvedBy !== d.issuerUserId || p.orgId !== d.orgId
    || !d.profiles.some((profile) => profile.profileId === p.profileId && profile.currencyCode === p.providerScope.currencyCode)
    || value.reservation.rows !== p.counts.providerRows
    || value.reservation.rows > d.limits.maximumRowsPerCall
    || p.counts.logicalChanges !== p.counts.providerRows || p.counts.uniqueEntities !== p.counts.providerRows
    || p.counts.byRoute['sp.v3.keywords.update'] !== p.counts.providerRows
    || Object.entries(p.counts.byRoute).some(([route, rows]) => route !== 'sp.v3.keywords.update' && rows !== 0)
    || value.reservation.day !== value.approvedAt.slice(0, 10)
    || Date.parse(value.gateSnapshot.checkedAt) > Date.parse(value.approvedAt)
    || Date.parse(value.mcpGate.checkedAt) > Date.parse(value.approvedAt)
    || Date.parse(value.approvedAt) < Date.parse(d.issuedAt)
    || Date.parse(value.approvedAt) >= Date.parse(value.expiresAt)
    || Date.parse(value.expiresAt) > Math.min(Date.parse(p.expiresAt), Date.parse(d.expiresAt))) {
    context.addIssue({ code: 'custom', message: 'delegated receipt scope, capacity, actor or authority window disagrees' });
  }
});
export type SpDelegatedAuthorizationReceiptV2 = z.infer<typeof SpDelegatedAuthorizationReceiptV2>;

export const SpWriteAuthorizationReceipt = z.discriminatedUnion('schemaVersion', [
  SpHumanAuthorizationReceiptV1, SpDelegatedAuthorizationReceiptV2,
]);
export type SpWriteAuthorizationReceipt = z.infer<typeof SpWriteAuthorizationReceipt>;

export const SpWriteAuthorizationActor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), userId: SpWriteUuid }).strict(),
  z.object({ kind: z.literal('mcp_key'), userId: SpWriteUuid, keyId: SpWriteUuid,
    delegationVersionId: SpWriteUuid }).strict(),
]);
export type SpWriteAuthorizationActor = z.infer<typeof SpWriteAuthorizationActor>;

/** Historical attribution derives from the immutable receipt, never from a live key join. */
export function spWriteAuthorizationActor(raw: SpWriteAuthorizationReceipt): SpWriteAuthorizationActor {
  const receipt = SpWriteAuthorizationReceipt.parse(raw);
  return receipt.approvalMode === 'delegated_mcp'
    ? { kind: 'mcp_key', userId: receipt.delegation.issuerUserId, keyId: receipt.delegation.keyId,
      delegationVersionId: receipt.delegation.versionId }
    : { kind: 'operator', userId: receipt.approvedBy };
}

/** Exact delta comparison; a ratio is multiplied as integers, never rounded by division. */
function relativeDeltaWithin(oldBid: SpCanonicalDecimal, newBid: SpCanonicalDecimal, ratio: SpCanonicalDecimal): boolean {
  const a = decimalParts(oldBid), b = decimalParts(newBid), r = decimalParts(ratio);
  const scale = Math.max(a.scale, b.scale);
  const oldUnits = a.coefficient * 10n ** BigInt(scale - a.scale);
  const newUnits = b.coefficient * 10n ** BigInt(scale - b.scale);
  const delta = oldUnits >= newUnits ? oldUnits - newUnits : newUnits - oldUnits;
  return delta * 10n ** BigInt(r.scale) <= oldUnits * r.coefficient;
}

/** Pure scope/cap proof. Current membership, revocation, gates and daily capacity remain SQL authority. */
export function verifyMcpPlanLimits(rawPlan: unknown, rawDelegation: unknown): void {
  const plan = SpWritePlan.parse(rawPlan);
  const delegation = McpWriteDelegation.parse(rawDelegation);
  if (plan.orgId !== delegation.orgId
    || !delegation.profiles.some((p) => p.profileId === plan.profileId && p.currencyCode === plan.providerScope.currencyCode)
    || plan.counts.providerRows > delegation.limits.maximumRowsPerCall) {
    throw new Error('MCP write plan exceeds delegation scope or row limit');
  }
  const absolute = delegation.limits.maximumAbsoluteDeltaByCurrency.find((money) => money.currencyCode === plan.providerScope.currencyCode);
  if (absolute === undefined) throw new Error('MCP write currency is not delegated');
  for (const action of plan.actions) {
    if (action.routeKey !== 'sp.v3.keywords.update' || Object.keys(action.changes).length !== 1
      || action.changes.bid === undefined) throw new Error('MCP delegation permits keyword bids only');
    const change = action.changes.bid;
    SpKeywordBidDecimal.parse(change.expected.amount);
    SpKeywordBidDecimal.parse(change.requested.amount);
    if (change.expected.amount === change.requested.amount
      || !decimalDeltaWithin(change.expected.amount, change.requested.amount, absolute.amount)
      || !relativeDeltaWithin(change.expected.amount, change.requested.amount, delegation.limits.maximumRelativeDelta)) {
      throw new Error('MCP write bid exceeds delegated delta limits');
    }
  }
}

export function verifyDelegatedSpWriteReceiptArtifacts(
  rawPlan: unknown, rawDelegation: unknown, rawRequest: unknown,
  rawReceipt: unknown, rawNow: unknown, hasher: SpWriteSha256Hasher,
): { plan: SpWritePlan; delegation: McpWriteDelegation; receipt: SpDelegatedAuthorizationReceiptV2 } {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const delegation = verifyMcpWriteDelegationFingerprint(rawDelegation, hasher);
  const request = McpBidApplyRequest.parse(rawRequest);
  const receipt = SpDelegatedAuthorizationReceiptV2.parse(rawReceipt);
  const now = SpWriteInstant.parse(rawNow);
  verifyMcpPlanLimits(plan, delegation);
  if (JSON.stringify(receipt.delegation) !== JSON.stringify(delegation)
    || JSON.stringify(receipt.plan) !== JSON.stringify(spWritePlanBinding(plan))
    || receipt.approvalRequestId !== request.requestId || plan.profileId !== request.profileId
    || plan.id !== request.planId || plan.fingerprint !== request.planFingerprint
    || (plan.source.kind === 'inverse_execution' && receipt.executionId !== plan.source.sourceExecutionId)
    || Date.parse(receipt.approvedAt) < Date.parse(plan.frozenAt)
    || Date.parse(receipt.approvedAt) > Date.parse(now) || Date.parse(now) >= Date.parse(receipt.expiresAt)) {
    throw new Error('delegated SP receipt differs from its exact admission artifacts');
  }
  return { plan, delegation, receipt };
}

/** No actor or authority artifact can be submitted by the MCP caller. */
export const McpBidApplyRequest = z.object({
  requestId: SpWriteUuid, profileId: SpWriteUuid, planId: SpWriteUuid, planFingerprint: SpWriteSha256,
}).strict();
export type McpBidApplyRequest = z.infer<typeof McpBidApplyRequest>;

/** Historical rehydration checks the recorded authority at admission, not today's key state. */
function verifyRecordedDelegatedReceipt(
  plan: SpWritePlan, receipt: SpWriteAuthorizationReceipt, hasher: SpWriteSha256Hasher,
): void {
  if (receipt.approvalMode !== 'delegated_mcp') return;
  verifyDelegatedSpWriteReceiptArtifacts(plan, receipt.delegation, {
    requestId: receipt.approvalRequestId, profileId: receipt.plan.profileId,
    planId: receipt.plan.planId, planFingerprint: receipt.plan.planFingerprint,
  }, receipt, receipt.approvedAt, hasher);
}

export type VerifiedSpWriteAuthorizationReceiptArtifacts =
  VerifiedSpWriteApprovalArtifacts & {
    receipt: SpHumanAuthorizationReceiptV1;
  };

export function verifySpWriteAuthorizationReceiptArtifacts(
  rawPlan: unknown,
  rawInverse: unknown | null,
  rawRequest: unknown,
  rawBoundedAuthorization: unknown | null,
  rawReceipt: unknown,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteAuthorizationReceiptArtifacts {
  const approval = verifySpWriteApprovalArtifacts(
    rawPlan,
    rawInverse,
    rawRequest,
    rawBoundedAuthorization,
    rawNow,
    hasher,
  );
  const receipt = SpHumanAuthorizationReceiptV1.parse(rawReceipt);
  const now = SpWriteInstant.parse(rawNow);
  const expectedInverse = approval.inverse === null
    ? null
    : spWritePlanBinding(approval.inverse);
  const expectedBoundedAuthorization = approval.boundedAuthorization === null
    ? null
    : {
        authorizationId: approval.boundedAuthorization.authorizationId,
        authorizationFingerprint: approval.boundedAuthorization.fingerprint,
        expiresAt: approval.boundedAuthorization.expiresAt,
      };

  if (receipt.approvalRequestId !== approval.request.approvalRequestId
    || receipt.approvalMode !== approval.request.approvalMode
    || receipt.confirmationVersion !== approval.request.confirmationVersion
    || JSON.stringify(receipt.plan) !== JSON.stringify(approval.request.plan)
    || JSON.stringify(receipt.preapprovedInversePlan) !== JSON.stringify(expectedInverse)
    || JSON.stringify(receipt.boundedAuthorization)
      !== JSON.stringify(expectedBoundedAuthorization)) {
    throw new Error('SP write authorization receipt does not match the approved artifacts');
  }
  if (Date.parse(receipt.approvedAt) < Date.parse(approval.plan.frozenAt)
    || Date.parse(receipt.approvedAt) > Date.parse(now)
    || Date.parse(now) >= Date.parse(receipt.expiresAt)) {
    throw new Error('SP write authorization receipt is not current for the frozen approval');
  }

  return { ...approval, receipt };
}

export const SpWriteDispatchJob = z.object({
  type: z.literal('sp_write.dispatch'),
  orgId: SpWriteUuid,
  profileId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  executionId: SpWriteUuid,
  approvalId: SpWriteUuid,
  generation: SpWriteUuid,
}).strict();
export type SpWriteDispatchJob = z.infer<typeof SpWriteDispatchJob>;

export const SpWriteObserveJob = z.object({
  type: z.literal('sp_write.observe'),
  orgId: SpWriteUuid,
  profileId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  executionId: SpWriteUuid,
  approvalId: SpWriteUuid,
  generation: SpWriteUuid,
  providerCallId: SpWriteUuid,
  attempt: z.number().int().nonnegative().max(7).default(0),
}).strict();
export type SpWriteObserveJob = z.infer<typeof SpWriteObserveJob>;

export const SpWriteFutureJobPayload = z.discriminatedUnion('type', [
  SpWriteDispatchJob,
  SpWriteObserveJob,
]);
export type SpWriteFutureJobPayload = z.infer<typeof SpWriteFutureJobPayload>;

function requireObservedValues(
  values: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (Object.values(values).every((value) => value === undefined)) {
    context.addIssue({ code: 'custom', path: ['values'], message: 'observed values cannot be empty' });
  }
}

const SpCampaignObservedAction = z.object({
  routeKey: z.literal('sp.v3.campaigns.update'),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  values: z.object({
    budget: SpMoney.optional(),
    state: SpMutableState.optional(),
    placement: SpCompleteCampaignBiddingState.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireObservedValues(value.values, context));

const SpAdGroupObservedAction = z.object({
  routeKey: z.literal('sp.v3.ad_groups.update'),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  values: z.object({
    defaultBid: SpMoney.optional(),
    state: SpMutableState.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireObservedValues(value.values, context));

const SpKeywordObservedAction = z.object({
  routeKey: z.literal('sp.v3.keywords.update'),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  values: z.object({
    bid: SpMoney.optional(),
    state: SpMutableState.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireObservedValues(value.values, context));

const SpTargetObservedAction = z.object({
  routeKey: z.literal('sp.v3.targets.update'),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  values: z.object({
    bid: SpMoney.optional(),
    state: SpMutableState.optional(),
  }).strict(),
}).strict().superRefine((value, context) => requireObservedValues(value.values, context));

const SpProductAdObservedAction = z.object({
  routeKey: z.literal('sp.v3.product_ads.update'),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  values: z.object({ state: SpMutableState }).strict(),
}).strict();

export const SpWriteObservedAction = z.discriminatedUnion('routeKey', [
  SpCampaignObservedAction,
  SpAdGroupObservedAction,
  SpKeywordObservedAction,
  SpTargetObservedAction,
  SpProductAdObservedAction,
]);
export type SpWriteObservedAction = z.infer<typeof SpWriteObservedAction>;

function observedActionForSide(
  action: SpWriteAction,
  side: 'expected' | 'requested',
): SpWriteObservedAction {
  const base = {
    routeKey: action.routeKey,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    amazonEntityId: entityIdForAction(action),
  };
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.budget === undefined
            ? {} : { budget: action.changes.budget[side] }),
          ...(action.changes.state === undefined
            ? {} : { state: action.changes.state[side] }),
          ...(action.changes.placement === undefined
            ? {} : { placement: action.changes.placement[side] }),
        },
      });
    case 'sp.v3.ad_groups.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.defaultBid === undefined
            ? {} : { defaultBid: action.changes.defaultBid[side] }),
          ...(action.changes.state === undefined
            ? {} : { state: action.changes.state[side] }),
        },
      });
    case 'sp.v3.keywords.update':
    case 'sp.v3.targets.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.bid === undefined
            ? {} : { bid: action.changes.bid[side] }),
          ...(action.changes.state === undefined
            ? {} : { state: action.changes.state[side] }),
        },
      });
    case 'sp.v3.product_ads.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: { state: action.changes.state?.[side] },
      });
  }
}

export const SpWritePredispatchObservation = z.object({
  schemaVersion: z.literal('openspell.sp-write-predispatch-observation.v1'),
  observationId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  approvalId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  routeKey: SpWriteRouteKey,
  observedAt: SpWriteInstant,
  validUntil: SpWriteInstant,
  items: z.array(SpWriteObservedAction).min(1).max(100),
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  const validityMs = Date.parse(value.validUntil) - Date.parse(value.observedAt);
  if (validityMs <= 0 || validityMs > 120_000) {
    context.addIssue({ code: 'custom', message: 'predispatch observation validity must be positive and at most two minutes' });
  }
  if (value.items.some((item) => item.routeKey !== value.routeKey)) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'predispatch observation mixes routes' });
  }
  const keys = value.items.map((item) => `${item.amazonEntityId}:${item.actionId}`);
  if (new Set(keys).size !== keys.length
    || keys.some((key, index) => index > 0 && (keys[index - 1] ?? '') >= key)) {
    context.addIssue({ code: 'custom', path: ['items'], message: 'predispatch items must be unique and in canonical order' });
  }
});
export type SpWritePredispatchObservation = z.infer<
  typeof SpWritePredispatchObservation
>;

export function serializeSpWritePredispatchObservationFingerprint(
  rawObservation: SpWritePredispatchObservation,
): string {
  const observation = SpWritePredispatchObservation.parse(rawObservation);
  const { fingerprint: _fingerprint, ...preimage } = observation;
  return JSON.stringify(['openspell.sp-write-predispatch-observation.v1', preimage]);
}

const SpWriteProviderCallPosition = z.object({
  requestIndex: z.number().int().nonnegative().max(99),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  amazonEntityId: AmazonId,
  actionRequestFingerprint: SpWriteSha256,
}).strict();

export const SpWriteProviderCallIntent = z.object({
  schemaVersion: z.literal('openspell.sp-write-provider-call-intent.v1'),
  intentId: SpWriteUuid,
  providerCallId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  approvalId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  routeKey: SpWriteRouteKey,
  attemptNumber: z.literal(1),
  dispatchLeaseId: SpWriteUuid,
  providerObservationFingerprint: SpWriteSha256,
  requestFingerprint: SpWriteSha256,
  recordedAt: SpWriteInstant,
  positions: z.array(SpWriteProviderCallPosition).min(1).max(100),
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  if (value.positions.some((position, index) => position.requestIndex !== index)) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'provider positions must cover a zero-based range exactly' });
  }
  if (new Set(value.positions.map((position) => position.actionId)).size
    !== value.positions.length) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'provider intent repeats an action' });
  }
});
export type SpWriteProviderCallIntent = z.infer<typeof SpWriteProviderCallIntent>;

export function serializeSpWriteProviderRequestFingerprint(
  rawIntent: SpWriteProviderCallIntent,
): string {
  const intent = SpWriteProviderCallIntent.parse(rawIntent);
  return JSON.stringify([
    'openspell.sp-write-provider-request.v1',
    intent.planId,
    intent.planFingerprint,
    intent.approvalId,
    intent.executionId,
    intent.generation,
    intent.providerCallId,
    intent.routeKey,
    intent.providerObservationFingerprint,
    intent.positions,
  ]);
}

export function serializeSpWriteProviderCallIntentFingerprint(
  rawIntent: SpWriteProviderCallIntent,
): string {
  const intent = SpWriteProviderCallIntent.parse(rawIntent);
  const { fingerprint: _fingerprint, ...preimage } = intent;
  return JSON.stringify(['openspell.sp-write-provider-call-intent.v1', preimage]);
}

export const SpWriteProviderPositionOutcome = z.enum([
  'accepted',
  'authoritative_rejected',
  'ambiguous',
]);
export type SpWriteProviderPositionOutcome = z.infer<
  typeof SpWriteProviderPositionOutcome
>;

const SpWriteProviderResultPosition = z.object({
  requestIndex: z.number().int().nonnegative().max(99),
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  actionRequestFingerprint: SpWriteSha256,
  outcome: SpWriteProviderPositionOutcome,
  providerEntityId: AmazonId.nullable(),
  code: z.string().trim().max(160).nullable(),
  message: z.string().trim().max(512).nullable(),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'accepted' && value.providerEntityId === null) {
    context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'accepted provider position requires the entity identity' });
  }
  if (value.outcome === 'ambiguous' && value.providerEntityId !== null) {
    context.addIssue({ code: 'custom', path: ['providerEntityId'], message: 'ambiguous provider position cannot claim an entity identity' });
  }
});

export const SpWriteProviderResult = z.object({
  schemaVersion: z.literal('openspell.sp-write-provider-result.v1'),
  resultId: SpWriteUuid,
  intentId: SpWriteUuid,
  intentFingerprint: SpWriteSha256,
  providerCallId: SpWriteUuid,
  requestFingerprint: SpWriteSha256,
  completedAt: SpWriteInstant,
  positions: z.array(SpWriteProviderResultPosition).min(1).max(100),
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  if (value.positions.some((position, index) => position.requestIndex !== index)) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'provider result positions must cover a zero-based range exactly' });
  }
  if (new Set(value.positions.map((position) => position.actionId)).size
    !== value.positions.length) {
    context.addIssue({ code: 'custom', path: ['positions'], message: 'provider result repeats an action' });
  }
});
export type SpWriteProviderResult = z.infer<typeof SpWriteProviderResult>;

export function serializeSpWriteProviderResultFingerprint(
  rawResult: SpWriteProviderResult,
): string {
  const result = SpWriteProviderResult.parse(rawResult);
  const { fingerprint: _fingerprint, ...preimage } = result;
  return JSON.stringify(['openspell.sp-write-provider-result.v1', preimage]);
}

export const SpWriteObservationOutcome = z.enum([
  'observed_requested',
  'observed_expected_after_ambiguous',
  'missing',
  'conflict',
]);
export type SpWriteObservationOutcome = z.infer<typeof SpWriteObservationOutcome>;

export const SpWriteObservation = z.object({
  schemaVersion: z.literal('openspell.sp-write-observation.v1'),
  observationId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  approvalId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  intentId: SpWriteUuid,
  intentFingerprint: SpWriteSha256,
  providerCallId: SpWriteUuid,
  requestFingerprint: SpWriteSha256,
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  routeKey: SpWriteRouteKey,
  sourceSyncJobId: SpWriteUuid,
  observedAt: SpWriteInstant,
  outcome: SpWriteObservationOutcome,
  observed: SpWriteObservedAction.nullable(),
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'missing') !== (value.observed === null)) {
    context.addIssue({ code: 'custom', path: ['observed'], message: 'only a missing observation has no observed values' });
  }
  if (value.observed !== null
    && (value.observed.actionId !== value.actionId
      || value.observed.actionFingerprint !== value.actionFingerprint
      || value.observed.routeKey !== value.routeKey)) {
    context.addIssue({ code: 'custom', path: ['observed'], message: 'observed values do not match the observation identity' });
  }
});
export type SpWriteObservation = z.infer<typeof SpWriteObservation>;

export function serializeSpWriteObservationFingerprint(
  rawObservation: SpWriteObservation,
): string {
  const observation = SpWriteObservation.parse(rawObservation);
  const { fingerprint: _fingerprint, ...preimage } = observation;
  return JSON.stringify(['openspell.sp-write-observation.v1', preimage]);
}

export const SpWriteRefusalReason = z.enum([
  'approval_expired',
  'authorization_revoked',
  'environment_gate_closed',
  'profile_gate_closed',
  'route_mismatch',
  'stale_expected_state',
  'unsupported_provider_state',
  'lease_unavailable',
  'duplicate_intent',
]);
export type SpWriteRefusalReason = z.infer<typeof SpWriteRefusalReason>;

export const SpWritePreDispatchDisposition = z.object({
  schemaVersion: z.literal('openspell.sp-write-predispatch-disposition.v1'),
  dispositionId: SpWriteUuid,
  planId: SpWriteUuid,
  planFingerprint: SpWriteSha256,
  approvalId: SpWriteUuid,
  executionId: SpWriteUuid,
  generation: SpWriteUuid,
  actionId: SpWriteUuid,
  actionFingerprint: SpWriteSha256,
  recordedAt: SpWriteInstant,
  outcome: z.literal('refused_before_dispatch'),
  reason: SpWriteRefusalReason,
  providerObservationFingerprint: SpWriteSha256.nullable(),
  fingerprint: SpWriteSha256,
}).strict().superRefine((value, context) => {
  if (value.reason === 'stale_expected_state'
    && value.providerObservationFingerprint === null) {
    context.addIssue({
      code: 'custom',
      path: ['providerObservationFingerprint'],
      message: 'provider-state refusal requires the observation fingerprint',
    });
  }
});
export type SpWritePreDispatchDisposition = z.infer<
  typeof SpWritePreDispatchDisposition
>;

export function serializeSpWritePreDispatchDispositionFingerprint(
  rawDisposition: SpWritePreDispatchDisposition,
): string {
  const disposition = SpWritePreDispatchDisposition.parse(rawDisposition);
  const { fingerprint: _fingerprint, ...preimage } = disposition;
  return JSON.stringify(['openspell.sp-write-predispatch-disposition.v1', preimage]);
}

export const SpWriteAccounting = z.object({
  approvedRows: count,
  pendingDispatch: count,
  refusedBeforeDispatch: count,
  intentCommitted: count,
  providerAccepted: count,
  providerRejected: count,
  providerAmbiguous: count,
  observedRequested: count,
  observedExpectedAfterAmbiguous: count,
  observationConflict: count,
  observationMissing: count,
  pendingObservation: count,
  providerCallsCommitted: count,
  providerCallsCompleted: count,
}).strict().superRefine((value, context) => {
  if (value.approvedRows
    !== value.pendingDispatch + value.refusedBeforeDispatch + value.intentCommitted) {
    context.addIssue({ code: 'custom', message: 'approved rows do not close across dispatch evidence' });
  }
  if (value.intentCommitted
    !== value.providerAccepted + value.providerRejected + value.providerAmbiguous) {
    context.addIssue({ code: 'custom', message: 'intent rows do not close across provider evidence' });
  }
  if (value.providerAccepted + value.providerAmbiguous
    !== value.observedRequested + value.observedExpectedAfterAmbiguous
      + value.observationConflict + value.observationMissing + value.pendingObservation) {
    context.addIssue({ code: 'custom', message: 'observation evidence does not close accepted and ambiguous rows' });
  }
  if (value.providerCallsCompleted > value.providerCallsCommitted) {
    context.addIssue({ code: 'custom', message: 'completed provider calls exceed committed intents' });
  }
});
export type SpWriteAccounting = z.infer<typeof SpWriteAccounting>;

export const SpWriteExecutionStatus = z.enum([
  'queued',
  'running',
  'awaiting_observation',
  'succeeded',
  'observed_after_ambiguous',
  'partial',
  'refused',
  'failed',
  'ambiguous',
  'conflict',
]);
export type SpWriteExecutionStatus = z.infer<typeof SpWriteExecutionStatus>;

export const SpWriteExecutionSnapshot = z.object({
  accounting: SpWriteAccounting,
  status: SpWriteExecutionStatus,
}).strict();
export type SpWriteExecutionSnapshot = z.infer<typeof SpWriteExecutionSnapshot>;

type SpWriteEvidenceWithoutSnapshot = {
  plan: SpWritePlan;
  authorization: SpWriteAuthorizationReceipt;
  predispatchObservations: SpWritePredispatchObservation[];
  predispatchDispositions: SpWritePreDispatchDisposition[];
  providerCallIntents: SpWriteProviderCallIntent[];
  providerResults: SpWriteProviderResult[];
  observations: SpWriteObservation[];
};

function resultOutcomeForAction(
  actionId: string,
  intents: readonly SpWriteProviderCallIntent[],
  results: readonly SpWriteProviderResult[],
): SpWriteProviderPositionOutcome | null {
  const intent = intents.find((candidate) =>
    candidate.positions.some((position) => position.actionId === actionId));
  if (intent === undefined) return null;
  const result = results.find((candidate) => candidate.intentId === intent.intentId);
  if (result === undefined) return 'ambiguous';
  return result.positions.find((position) => position.actionId === actionId)?.outcome
    ?? 'ambiguous';
}

export function deriveSpWriteExecutionSnapshot(
  evidence: SpWriteEvidenceWithoutSnapshot,
): SpWriteExecutionSnapshot {
  const dispositionActions = new Set(
    evidence.predispatchDispositions.map((item) => item.actionId),
  );
  const intendedActions = new Set(
    evidence.providerCallIntents.flatMap((intent) =>
      intent.positions.map((position) => position.actionId)),
  );
  const observationByAction = new Map(
    evidence.observations.map((observation) => [observation.actionId, observation]),
  );

  let providerAccepted = 0;
  let providerRejected = 0;
  let providerAmbiguous = 0;
  let observedRequested = 0;
  let observedExpectedAfterAmbiguous = 0;
  let observationConflict = 0;
  let observationMissing = 0;
  let pendingObservation = 0;

  for (const action of evidence.plan.actions) {
    if (!intendedActions.has(action.actionId)) continue;
    const providerOutcome = resultOutcomeForAction(
      action.actionId,
      evidence.providerCallIntents,
      evidence.providerResults,
    );
    if (providerOutcome === 'accepted') providerAccepted += 1;
    else if (providerOutcome === 'authoritative_rejected') providerRejected += 1;
    else providerAmbiguous += 1;

    if (providerOutcome === 'authoritative_rejected') continue;
    const observation = observationByAction.get(action.actionId);
    if (observation === undefined) pendingObservation += 1;
    else if (observation.outcome === 'observed_requested') observedRequested += 1;
    else if (observation.outcome === 'observed_expected_after_ambiguous') {
      observedExpectedAfterAmbiguous += 1;
    } else if (observation.outcome === 'missing') observationMissing += 1;
    else observationConflict += 1;
  }

  const accounting = SpWriteAccounting.parse({
    approvedRows: evidence.plan.counts.providerRows,
    pendingDispatch: evidence.plan.counts.providerRows
      - dispositionActions.size - intendedActions.size,
    refusedBeforeDispatch: dispositionActions.size,
    intentCommitted: intendedActions.size,
    providerAccepted,
    providerRejected,
    providerAmbiguous,
    observedRequested,
    observedExpectedAfterAmbiguous,
    observationConflict,
    observationMissing,
    pendingObservation,
    providerCallsCommitted: evidence.providerCallIntents.length,
    providerCallsCompleted: evidence.providerResults.length,
  });

  let status: SpWriteExecutionStatus;
  if (accounting.observationConflict > 0 || accounting.observationMissing > 0) {
    status = 'conflict';
  } else if (accounting.pendingDispatch === accounting.approvedRows) {
    status = 'queued';
  } else if (accounting.pendingDispatch > 0) {
    status = 'running';
  } else if (accounting.pendingObservation > 0) {
    status = 'awaiting_observation';
  } else if (accounting.providerAccepted === accounting.approvedRows
    && accounting.observedRequested === accounting.approvedRows) {
    status = 'succeeded';
  } else if (accounting.providerAmbiguous > 0
    && accounting.providerRejected === 0
    && accounting.refusedBeforeDispatch === 0
    && accounting.observedRequested === accounting.providerAccepted + accounting.providerAmbiguous) {
    status = 'observed_after_ambiguous';
  } else if (accounting.refusedBeforeDispatch === accounting.approvedRows) {
    status = 'refused';
  } else if (accounting.providerRejected === accounting.approvedRows) {
    status = 'failed';
  } else if (accounting.providerAmbiguous > 0
    || accounting.observedExpectedAfterAmbiguous > 0) {
    status = 'ambiguous';
  } else {
    status = 'partial';
  }
  return SpWriteExecutionSnapshot.parse({ accounting, status });
}

const SpWriteExecutionEvidenceBase = z.object({
  plan: SpWritePlan,
  authorization: SpWriteAuthorizationReceipt,
  predispatchObservations: z.array(SpWritePredispatchObservation),
  predispatchDispositions: z.array(SpWritePreDispatchDisposition),
  providerCallIntents: z.array(SpWriteProviderCallIntent),
  providerResults: z.array(SpWriteProviderResult),
  observations: z.array(SpWriteObservation),
}).strict();

export const SpWriteExecutionEvidence = SpWriteExecutionEvidenceBase.extend({
  snapshot: SpWriteExecutionSnapshot,
}).strict().superRefine((evidence, context) => {
  validateEvidenceRelations(evidence, context);
  const derived = deriveSpWriteExecutionSnapshot(evidence);
  if (JSON.stringify(derived) !== JSON.stringify(evidence.snapshot)) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'SP write snapshot differs from exact evidence' });
  }
});
export type SpWriteExecutionEvidence = z.infer<typeof SpWriteExecutionEvidence>;

function planBindingAuthorizedByReceipt(
  plan: SpWritePlan,
  receipt: SpWriteAuthorizationReceipt,
): boolean {
  const binding = spWritePlanBinding(plan);
  return JSON.stringify(binding) === JSON.stringify(receipt.plan)
    || (receipt.preapprovedInversePlan !== null
      && JSON.stringify(binding) === JSON.stringify(receipt.preapprovedInversePlan));
}

function commonEvidenceIdentity(
  value: {
    planId: string;
    planFingerprint: string;
    approvalId: string;
    executionId: string;
    generation: string;
  },
  evidence: SpWriteEvidenceWithoutSnapshot,
): boolean {
  return value.planId === evidence.plan.id
    && value.planFingerprint === evidence.plan.fingerprint
    && value.approvalId === evidence.authorization.approvalId
    && value.executionId === evidence.authorization.executionId
    && value.generation === evidence.authorization.generation;
}

function validateResultAgainstIntent(
  result: SpWriteProviderResult,
  intent: SpWriteProviderCallIntent,
): boolean {
  return result.intentId === intent.intentId
    && result.intentFingerprint === intent.fingerprint
    && result.providerCallId === intent.providerCallId
    && result.requestFingerprint === intent.requestFingerprint
    && result.positions.length === intent.positions.length
    && result.positions.every((position, index) => {
      const intended = intent.positions[index];
      return intended !== undefined
        && position.requestIndex === intended.requestIndex
        && position.actionId === intended.actionId
        && position.actionFingerprint === intended.actionFingerprint
        && position.actionRequestFingerprint === intended.actionRequestFingerprint
        && (position.providerEntityId === null
          || position.providerEntityId === intended.amazonEntityId);
    });
}

function expectedObservationOutcome(
  action: SpWriteAction,
  providerOutcome: SpWriteProviderPositionOutcome,
  observed: SpWriteObservedAction | null,
): SpWriteObservationOutcome | null {
  if (providerOutcome === 'authoritative_rejected') return null;
  if (observed === null) return 'missing';
  if (JSON.stringify(observed) === JSON.stringify(observedActionForSide(action, 'requested'))) {
    return 'observed_requested';
  }
  if (providerOutcome === 'ambiguous'
    && JSON.stringify(observed) === JSON.stringify(observedActionForSide(action, 'expected'))) {
    return 'observed_expected_after_ambiguous';
  }
  return 'conflict';
}

function observedActionMatchesIdentity(
  action: SpWriteAction,
  observed: SpWriteObservedAction,
): boolean {
  const expected = observedActionForSide(action, 'expected');
  return observed.routeKey === expected.routeKey
    && observed.actionId === expected.actionId
    && observed.actionFingerprint === expected.actionFingerprint
    && observed.amazonEntityId === expected.amazonEntityId;
}

function observedActionCoversChangedValues(
  action: SpWriteAction,
  observed: SpWriteObservedAction,
): boolean {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update':
      return observed.routeKey === action.routeKey
        && (action.changes.budget === undefined || observed.values.budget !== undefined)
        && (action.changes.state === undefined || observed.values.state !== undefined)
        && (action.changes.placement === undefined || observed.values.placement !== undefined);
    case 'sp.v3.ad_groups.update':
      return observed.routeKey === action.routeKey
        && (action.changes.defaultBid === undefined || observed.values.defaultBid !== undefined)
        && (action.changes.state === undefined || observed.values.state !== undefined);
    case 'sp.v3.keywords.update':
    case 'sp.v3.targets.update':
      return observed.routeKey === action.routeKey
        && (action.changes.bid === undefined || observed.values.bid !== undefined)
        && (action.changes.state === undefined || observed.values.state !== undefined);
    case 'sp.v3.product_ads.update':
      return observed.routeKey === action.routeKey
        && observed.values.state !== undefined;
  }
}

function addRelationIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path, message });
}

function validateEvidenceRelations(
  evidence: SpWriteEvidenceWithoutSnapshot,
  context: z.RefinementCtx,
): void {
  if (!planBindingAuthorizedByReceipt(evidence.plan, evidence.authorization)) {
    addRelationIssue(context, ['authorization'], 'authorization receipt does not bind the evidence plan');
  }
  const actions = new Map(evidence.plan.actions.map((action) => [action.actionId, action]));
  const dispositionActions = new Set<string>();
  const dispositionIds = new Set<string>();
  const intendedActions = new Set<string>();
  const intentIds = new Set<string>();
  const providerCallIds = new Set<string>();

  for (const [index, disposition] of evidence.predispatchDispositions.entries()) {
    const action = actions.get(disposition.actionId);
    if (!commonEvidenceIdentity(disposition, evidence)
      || action === undefined || action.fingerprint !== disposition.actionFingerprint
      || Date.parse(disposition.recordedAt) < Date.parse(evidence.authorization.approvedAt)
      || Date.parse(disposition.recordedAt) > Date.parse(evidence.authorization.expiresAt)
      || dispositionActions.has(disposition.actionId)
      || dispositionIds.has(disposition.dispositionId)) {
      addRelationIssue(context, ['predispatchDispositions', index], 'invalid or duplicate predispatch disposition');
    }
    dispositionActions.add(disposition.actionId);
    dispositionIds.add(disposition.dispositionId);
    if (disposition.providerObservationFingerprint !== null) {
      const providerObservation = evidence.predispatchObservations.find(
        (observation) => observation.fingerprint === disposition.providerObservationFingerprint,
      );
      const observed = providerObservation?.items.find(
        (item) => item.actionId === disposition.actionId,
      );
      if (action === undefined || providerObservation === undefined || observed === undefined
        || !commonEvidenceIdentity(providerObservation, evidence)
        || !observedActionMatchesIdentity(action, observed)
        || !observedActionCoversChangedValues(action, observed)
        || (disposition.reason === 'stale_expected_state'
          && JSON.stringify(observed) === JSON.stringify(observedActionForSide(action, 'expected')))) {
        addRelationIssue(context, ['predispatchDispositions', index], 'predispatch refusal observation does not prove its action reason');
      }
    }
  }

  for (const [intentIndex, intent] of evidence.providerCallIntents.entries()) {
    if (!commonEvidenceIdentity(intent, evidence)
      || Date.parse(intent.recordedAt) < Date.parse(evidence.authorization.approvedAt)
      || Date.parse(intent.recordedAt) > Date.parse(evidence.authorization.expiresAt)
      || intentIds.has(intent.intentId) || providerCallIds.has(intent.providerCallId)) {
      addRelationIssue(context, ['providerCallIntents', intentIndex], 'invalid or duplicate provider intent identity');
    }
    intentIds.add(intent.intentId);
    providerCallIds.add(intent.providerCallId);
    const providerObservation = evidence.predispatchObservations.find(
      (observation) => observation.fingerprint === intent.providerObservationFingerprint,
    );
    if (providerObservation === undefined
      || !commonEvidenceIdentity(providerObservation, evidence)
      || providerObservation.routeKey !== intent.routeKey
      || Date.parse(providerObservation.observedAt)
        < Date.parse(evidence.authorization.approvedAt)
      || Date.parse(providerObservation.observedAt) > Date.parse(intent.recordedAt)
      || Date.parse(intent.recordedAt) > Date.parse(providerObservation.validUntil)) {
      addRelationIssue(context, ['providerCallIntents', intentIndex], 'provider intent lacks its fresh exact observation');
    }
    for (const [positionIndex, position] of intent.positions.entries()) {
      const action = actions.get(position.actionId);
      if (action === undefined || action.routeKey !== intent.routeKey
        || action.fingerprint !== position.actionFingerprint
        || entityIdForAction(action) !== position.amazonEntityId
        || dispositionActions.has(position.actionId) || intendedActions.has(position.actionId)) {
        addRelationIssue(context, ['providerCallIntents', intentIndex, 'positions', positionIndex], 'provider intent position does not match one available plan action');
      }
      intendedActions.add(position.actionId);
      const observedItem = providerObservation?.items[positionIndex];
      if (observedItem === undefined
        || JSON.stringify(observedItem) !== JSON.stringify(observedActionForSide(action!, 'expected'))) {
        addRelationIssue(context, ['providerCallIntents', intentIndex, 'positions', positionIndex], 'predispatch observation does not reproduce expected plan values');
      }
    }
  }

  const predispatchIds = evidence.predispatchObservations.map(
    (observation) => observation.observationId,
  );
  const predispatchFingerprints = evidence.predispatchObservations.map(
    (observation) => observation.fingerprint,
  );
  if (new Set(predispatchIds).size !== predispatchIds.length
    || new Set(predispatchFingerprints).size !== predispatchFingerprints.length
    || evidence.predispatchObservations.some((observation) => {
      const intentReferences = evidence.providerCallIntents.filter((intent) =>
        intent.providerObservationFingerprint === observation.fingerprint).length;
      const dispositionReferences = evidence.predispatchDispositions.filter((disposition) =>
        disposition.providerObservationFingerprint === observation.fingerprint).length;
      return intentReferences + dispositionReferences === 0 || intentReferences > 1;
    })) {
    addRelationIssue(context, ['predispatchObservations'], 'predispatch observations must be unique and referenced by exact evidence');
  }

  const resultIntentIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const [index, result] of evidence.providerResults.entries()) {
    const intent = evidence.providerCallIntents.find((candidate) => candidate.intentId === result.intentId);
    if (intent === undefined || resultIntentIds.has(result.intentId) || resultIds.has(result.resultId)
      || !validateResultAgainstIntent(result, intent)
      || Date.parse(result.completedAt) < Date.parse(intent.recordedAt)) {
      addRelationIssue(context, ['providerResults', index], 'provider result does not match one exact intent');
    }
    resultIntentIds.add(result.intentId);
    resultIds.add(result.resultId);
  }

  const observedActions = new Set<string>();
  const observationIds = new Set<string>();
  for (const [index, observation] of evidence.observations.entries()) {
    const action = actions.get(observation.actionId);
    const intent = evidence.providerCallIntents.find((candidate) =>
      candidate.intentId === observation.intentId
      && candidate.positions.some((position) => position.actionId === observation.actionId));
    const providerOutcome = intent === undefined ? null : resultOutcomeForAction(
      observation.actionId,
      evidence.providerCallIntents,
      evidence.providerResults,
    );
    const result = intent === undefined
      ? undefined
      : evidence.providerResults.find((candidate) => candidate.intentId === intent.intentId);
    const expectedOutcome = action === undefined || providerOutcome === null
      ? null
      : expectedObservationOutcome(action, providerOutcome, observation.observed);
    if (!commonEvidenceIdentity(observation, evidence)
      || action === undefined || intent === undefined || result === undefined
      || observation.intentFingerprint !== intent.fingerprint
      || observation.providerCallId !== intent.providerCallId
      || observation.requestFingerprint !== intent.requestFingerprint
      || observation.actionFingerprint !== action.fingerprint
      || observation.routeKey !== action.routeKey
      || observedActions.has(observation.actionId) || observationIds.has(observation.observationId)
      || expectedOutcome === null || observation.outcome !== expectedOutcome
      || Date.parse(observation.observedAt) < Date.parse(result.completedAt)) {
      addRelationIssue(context, ['observations', index], 'observation does not match exact provider and plan evidence');
    }
    observedActions.add(observation.actionId);
    observationIds.add(observation.observationId);
  }
}

function verifyFingerprint(
  actual: string,
  expected: string,
  label: string,
): void {
  if (actual !== expected) throw new Error(`${label} fingerprint mismatch`);
}

export function verifySpWriteExecutionEvidence(
  rawEvidence: unknown,
  hasher: SpWriteSha256Hasher,
): SpWriteExecutionEvidence {
  const evidence = SpWriteExecutionEvidence.parse(rawEvidence);
  verifySpWritePlanFingerprints(evidence.plan, hasher);
  verifyRecordedDelegatedReceipt(evidence.plan, evidence.authorization, hasher);
  for (const observation of evidence.predispatchObservations) {
    verifyFingerprint(
      digestSha256(serializeSpWritePredispatchObservationFingerprint(observation), hasher),
      observation.fingerprint,
      'SP write predispatch observation',
    );
  }
  for (const disposition of evidence.predispatchDispositions) {
    verifyFingerprint(
      digestSha256(serializeSpWritePreDispatchDispositionFingerprint(disposition), hasher),
      disposition.fingerprint,
      'SP write disposition',
    );
  }
  for (const intent of evidence.providerCallIntents) {
    verifyFingerprint(
      digestSha256(serializeSpWriteProviderRequestFingerprint(intent), hasher),
      intent.requestFingerprint,
      'SP write provider request',
    );
    verifyFingerprint(
      digestSha256(serializeSpWriteProviderCallIntentFingerprint(intent), hasher),
      intent.fingerprint,
      'SP write provider intent',
    );
  }
  for (const result of evidence.providerResults) {
    verifyFingerprint(
      digestSha256(serializeSpWriteProviderResultFingerprint(result), hasher),
      result.fingerprint,
      'SP write provider result',
    );
  }
  for (const observation of evidence.observations) {
    verifyFingerprint(
      digestSha256(serializeSpWriteObservationFingerprint(observation), hasher),
      observation.fingerprint,
      'SP write observation',
    );
  }
  return evidence;
}

function jobPlanBinding(
  job: SpWriteFutureJobPayload,
): { planId: string; planFingerprint: string } {
  return { planId: job.planId, planFingerprint: job.planFingerprint };
}

export type VerifiedSpWriteJobArtifacts = {
  plan: SpWritePlan;
  authorization: SpWriteAuthorizationReceipt;
  job: SpWriteFutureJobPayload;
};

function verifySpWriteJobIdentityArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteJobArtifacts {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const authorization = SpWriteAuthorizationReceipt.parse(rawAuthorization);
  const job = SpWriteFutureJobPayload.parse(rawJob);
  verifyRecordedDelegatedReceipt(plan, authorization, hasher);
  if (!planBindingAuthorizedByReceipt(plan, authorization)
    || JSON.stringify(jobPlanBinding(job)) !== JSON.stringify({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
    })
    || job.orgId !== plan.orgId || job.profileId !== plan.profileId
    || job.executionId !== authorization.executionId
    || job.approvalId !== authorization.approvalId
    || job.generation !== authorization.generation) {
    throw new Error('SP write job, plan, and authorization do not match');
  }
  return { plan, authorization, job };
}

export function verifySpWriteJobArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteJobArtifacts {
  const artifacts = verifySpWriteJobIdentityArtifacts(
    rawPlan,
    rawAuthorization,
    rawJob,
    hasher,
  );
  const now = SpWriteInstant.parse(rawNow);
  if (artifacts.job.type === 'sp_write.dispatch'
    && (Date.parse(now) >= Date.parse(artifacts.authorization.expiresAt)
      || Date.parse(now) >= Date.parse(artifacts.plan.expiresAt))) {
    throw new Error('SP write job authority is expired');
  }
  return artifacts;
}

export type VerifiedSpWriteDispatchArtifacts = VerifiedSpWriteJobArtifacts & {
  evidence: SpWriteExecutionEvidence;
  sourceExecutionEvidence: SpWriteExecutionEvidence | null;
  providerObservation: SpWritePredispatchObservation;
  intent: SpWriteProviderCallIntent;
};

export function verifySpWriteDispatchArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawEvidence: unknown,
  rawSourceExecutionEvidence: unknown | null,
  rawProviderObservation: unknown,
  rawIntent: unknown,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteDispatchArtifacts {
  const artifacts = verifySpWriteJobArtifacts(
    rawPlan,
    rawAuthorization,
    rawJob,
    rawNow,
    hasher,
  );
  if (artifacts.job.type !== 'sp_write.dispatch') {
    throw new Error('SP write dispatch verifier requires a dispatch job');
  }
  const evidence = verifySpWriteExecutionEvidence(rawEvidence, hasher);
  if (JSON.stringify(evidence.plan) !== JSON.stringify(artifacts.plan)
    || JSON.stringify(evidence.authorization) !== JSON.stringify(artifacts.authorization)) {
    throw new Error('SP write current evidence does not match dispatch authority');
  }
  let sourceExecutionEvidence: SpWriteExecutionEvidence | null = null;
  if (artifacts.plan.direction === 'inverse') {
    if (rawSourceExecutionEvidence === null
      || artifacts.plan.source.kind !== 'inverse_execution') {
      throw new Error('inverse SP write dispatch requires its observed source execution');
    }
    sourceExecutionEvidence = verifySpWriteExecutionEvidence(
      rawSourceExecutionEvidence,
      hasher,
    );
    verifySpWriteInversePair(sourceExecutionEvidence.plan, artifacts.plan, hasher);
    if (sourceExecutionEvidence.authorization.executionId
        !== artifacts.plan.source.sourceExecutionId
      || !['succeeded', 'observed_after_ambiguous'].includes(
        sourceExecutionEvidence.snapshot.status,
      )
      || sourceExecutionEvidence.snapshot.accounting.observedRequested
        !== sourceExecutionEvidence.plan.counts.providerRows) {
      throw new Error('inverse SP write source execution is not completely observed at requested values');
    }
  } else if (rawSourceExecutionEvidence !== null) {
    throw new Error('forward SP write dispatch cannot use inverse source evidence');
  }
  const providerObservation = SpWritePredispatchObservation.parse(rawProviderObservation);
  const intent = SpWriteProviderCallIntent.parse(rawIntent);
  verifyFingerprint(
    digestSha256(serializeSpWritePredispatchObservationFingerprint(providerObservation), hasher),
    providerObservation.fingerprint,
    'SP write predispatch observation',
  );
  verifyFingerprint(
    digestSha256(serializeSpWriteProviderRequestFingerprint(intent), hasher),
    intent.requestFingerprint,
    'SP write provider request',
  );
  verifyFingerprint(
    digestSha256(serializeSpWriteProviderCallIntentFingerprint(intent), hasher),
    intent.fingerprint,
    'SP write provider intent',
  );
  const now = SpWriteInstant.parse(rawNow);
  const {
    snapshot: _snapshot,
    ...evidenceWithoutSnapshot
  } = evidence;
  const identityEvidence: SpWriteEvidenceWithoutSnapshot = {
    ...evidenceWithoutSnapshot,
    predispatchObservations: [providerObservation],
    providerCallIntents: [intent],
    providerResults: [],
    observations: [],
  };
  if (!commonEvidenceIdentity(providerObservation, identityEvidence)
    || !commonEvidenceIdentity(intent, identityEvidence)
    || intent.providerObservationFingerprint !== providerObservation.fingerprint
    || Date.parse(now) > Date.parse(providerObservation.validUntil)
    || Date.parse(intent.recordedAt) > Date.parse(now)) {
    throw new Error('SP write dispatch observation or intent identity is stale or mismatched');
  }
  const usedActions = new Set([
    ...evidence.predispatchDispositions.map((item) => item.actionId),
    ...evidence.providerCallIntents.flatMap((item) =>
      item.positions.map((position) => position.actionId)),
  ]);
  if (intent.positions.some((position) => usedActions.has(position.actionId))) {
    throw new Error('SP write action already has terminal or write-ahead evidence');
  }
  const candidateEvidence: SpWriteEvidenceWithoutSnapshot = {
    ...evidenceWithoutSnapshot,
    predispatchObservations: [...evidence.predispatchObservations, providerObservation],
    providerCallIntents: [...evidence.providerCallIntents, intent],
  };
  const relationCheck = SpWriteExecutionEvidenceBase.safeParse(candidateEvidence);
  if (!relationCheck.success) {
    throw new Error(`SP write dispatch artifacts are structurally invalid: ${relationCheck.error.message}`);
  }
  const relationContextIssues: string[] = [];
  validateEvidenceRelations(candidateEvidence, {
    addIssue(issue) {
      relationContextIssues.push(typeof issue === 'string' ? issue : (issue.message ?? 'invalid'));
    },
  } as z.RefinementCtx);
  if (relationContextIssues.length > 0) throw new Error(relationContextIssues[0]);
  return {
    ...artifacts,
    evidence,
    sourceExecutionEvidence,
    providerObservation,
    intent,
  };
}

export type VerifiedSpWriteProviderResultArtifacts = {
  plan: SpWritePlan;
  authorization: SpWriteAuthorizationReceipt;
  evidence: SpWriteExecutionEvidence;
  result: SpWriteProviderResult;
};

export function verifySpWriteProviderResultArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawEvidence: unknown,
  rawResult: unknown,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteProviderResultArtifacts {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  const authorization = SpWriteAuthorizationReceipt.parse(rawAuthorization);
  const evidence = verifySpWriteExecutionEvidence(rawEvidence, hasher);
  const result = SpWriteProviderResult.parse(rawResult);
  const now = SpWriteInstant.parse(rawNow);
  verifyFingerprint(
    digestSha256(serializeSpWriteProviderResultFingerprint(result), hasher),
    result.fingerprint,
    'SP write provider result',
  );
  const intent = evidence.providerCallIntents.find((item) => item.intentId === result.intentId);
  if (plan.id !== evidence.plan.id
    || JSON.stringify(plan) !== JSON.stringify(evidence.plan)
    || JSON.stringify(authorization) !== JSON.stringify(evidence.authorization)
    || intent === undefined || !validateResultAgainstIntent(result, intent)
    || evidence.providerResults.some((item) => item.intentId === result.intentId)
    || Date.parse(result.completedAt) < Date.parse(intent.recordedAt)
    || Date.parse(result.completedAt) > Date.parse(now)) {
    throw new Error('SP write provider result does not match one open intent');
  }
  return { plan, authorization, evidence, result };
}

export type VerifiedSpWriteObservationArtifacts = VerifiedSpWriteJobArtifacts & {
  evidence: SpWriteExecutionEvidence;
  observation: SpWriteObservation;
};

export function verifySpWriteObservationArtifacts(
  rawPlan: unknown,
  rawAuthorization: unknown,
  rawJob: unknown,
  rawEvidence: unknown,
  rawObservation: unknown,
  rawNow: unknown,
  hasher: SpWriteSha256Hasher,
): VerifiedSpWriteObservationArtifacts {
  const artifacts = verifySpWriteJobIdentityArtifacts(
    rawPlan,
    rawAuthorization,
    rawJob,
    hasher,
  );
  const job = artifacts.job;
  if (job.type !== 'sp_write.observe') {
    throw new Error('SP write observation verifier requires an observation job');
  }
  const evidence = verifySpWriteExecutionEvidence(rawEvidence, hasher);
  const observation = SpWriteObservation.parse(rawObservation);
  const now = SpWriteInstant.parse(rawNow);
  verifyFingerprint(
    digestSha256(serializeSpWriteObservationFingerprint(observation), hasher),
    observation.fingerprint,
    'SP write observation',
  );
  const intent = evidence.providerCallIntents.find(
    (candidate) => candidate.intentId === observation.intentId
      && candidate.providerCallId === job.providerCallId,
  );
  const action = artifacts.plan.actions.find((candidate) =>
    candidate.actionId === observation.actionId);
  const providerOutcome = intent === undefined ? null : resultOutcomeForAction(
    observation.actionId,
    evidence.providerCallIntents,
    evidence.providerResults,
  );
  const expectedOutcome = action === undefined || providerOutcome === null
    ? null
    : expectedObservationOutcome(action, providerOutcome, observation.observed);
  const intentPosition = intent?.positions.find(
    (position) => position.actionId === observation.actionId,
  );
  const result = intent === undefined
    ? undefined
    : evidence.providerResults.find((candidate) => candidate.intentId === intent.intentId);
  if (JSON.stringify(evidence.plan) !== JSON.stringify(artifacts.plan)
    || JSON.stringify(evidence.authorization) !== JSON.stringify(artifacts.authorization)
    || intent === undefined || action === undefined || intentPosition === undefined
    || result === undefined
    || !commonEvidenceIdentity(observation, evidence)
    || observation.intentFingerprint !== intent.fingerprint
    || observation.providerCallId !== intent.providerCallId
    || observation.requestFingerprint !== intent.requestFingerprint
    || observation.actionFingerprint !== action.fingerprint
    || observation.actionFingerprint !== intentPosition.actionFingerprint
    || observation.routeKey !== action.routeKey
    || observation.routeKey !== intent.routeKey
    || expectedOutcome === null || observation.outcome !== expectedOutcome
    || evidence.observations.some((item) => item.actionId === observation.actionId)
    || evidence.observations.some((item) => item.observationId === observation.observationId)
    || Date.parse(observation.observedAt) < Date.parse(result.completedAt)
    || Date.parse(observation.observedAt) > Date.parse(now)) {
    throw new Error('SP write observation does not match one open observation position');
  }
  return { ...artifacts, evidence, observation };
}
