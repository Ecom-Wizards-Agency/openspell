import {
  SpWriteObservedAction,
  type SpCompleteCampaignBiddingState,
  type SpWriteAction,
  type SpWritePlan,
  type SpWriteProviderCallIntent,
  type SpWriteProviderResult,
  type SpWriteProviderScope,
  type SpWriteRouteKey,
  type SpWriteSha256Hasher,
  verifySpWritePlanFingerprints,
} from '@wizard-ads/shared/sp-writes';

const MAX_CALL_SIZE = 100;
const ACTION_REQUEST_DOMAIN = 'openspell.sp-write-action-request.v1';

type MoneyRule = Readonly<{
  region: SpWriteProviderScope['region'];
  currencyCode: string;
  scale: number;
  bidMin: string;
  bidMax: string;
  budgetMin: string;
  budgetMax: string;
}>;

/**
 * Active marketplace identities plus the SP rows in Amazon's limits table,
 * captured 2026-08-31. China is not present because the current active-store
 * table has no China identity and the limits table has no current SP bid row.
 */
const MONEY_RULES: Readonly<Record<string, MoneyRule>> = Object.freeze({
  A1AM78C64UM0Y8: rule('NA', 'MXN', 2, '0.1', '20000', '1', '21000000'),
  A1F83G8C2ARO7P: rule('EU', 'GBP', 2, '0.02', '1000', '1', '1000000'),
  A1PA6795UKMFR9: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A2EUQ1WTGCTBG2: rule('NA', 'CAD', 2, '0.02', '1000', '1', '1000000'),
  A39IBJ37TRP1C6: rule('FE', 'AUD', 2, '0.02', '1410', '1.4', '1500000'),
  ATVPDKIKX0DER: rule('NA', 'USD', 2, '0.02', '1000', '1', '1000000'),
  A13V1IB3VIYZZH: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1RKKUPIHCS9HS: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  APJ6JRA9NG5V4: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1805IZSGTT6HS: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1VC38T7YXB528: rule('FE', 'JPY', 0, '2', '100000', '100', '21000000'),
  A2VIGQ35RCS4UG: rule('EU', 'AED', 2, '0.24', '184', '4', '3700000'),
  A2Q3Y263D00KWC: rule('NA', 'BRL', 2, '0.07', '3700', '1.32', '5300000'),
  A19VAU5U5O7RUS: rule('FE', 'SGD', 2, '0.02', '1100', '1.39', '1300000'),
  A2NODRKZP88ZB9: rule('EU', 'SEK', 2, '0.18', '9300', '9', '9300000'),
  A21TJRUUN4KGV: rule('EU', 'INR', 2, '1', '5000', '50', '21000000'),
  A1C3SOZRARQ6R3: rule('EU', 'PLN', 2, '0.04', '2000', '2', '2000000'),
  A33AVAJ2PDY3EV: rule('EU', 'TRY', 2, '0.05', '2500', '2', '2500000'),
  ARBP9OOSHTCHU: rule('EU', 'EGP', 2, '0.15', '5.5', '7', '7400000'),
  A17E79C6D8DWNP: rule('EU', 'SAR', 2, '0.1', '3670', '4', '3700000'),
  AMEN7PMS3EDWL: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  AE08WJ6YKNBMC: rule('EU', 'ZAR', 2, '1', '7000', '20', '7000000'),
  A28R8C7NBKEWEA: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
});

function rule(
  region: MoneyRule['region'],
  currencyCode: string,
  scale: number,
  bidMin: string,
  bidMax: string,
  budgetMin: string,
  budgetMax: string,
): MoneyRule {
  return Object.freeze({ region, currencyCode, scale, bidMin, bidMax, budgetMin, budgetMax });
}

type RouteSpec = Readonly<{
  path: string;
  mediaType: string;
  requestKey: string;
  responseKey: string;
  idKey: string;
  listPath: string;
  listResponseKey: string;
  idFilterKey: string;
  errorSelectorKeys: readonly string[];
}>;

type ErrorDetailPolicy = Readonly<{
  allowedKeys: readonly string[];
  requiredKeys: readonly string[];
  reasons: readonly string[];
}>;

const BASIC_ERROR_KEYS = ['cause', 'message', 'reason'] as const;
const MARKET_ERROR_KEYS = ['cause', 'marketplace', 'message', 'reason'] as const;

function errorPolicy(
  reasons: readonly string[],
  allowedKeys: readonly string[] = BASIC_ERROR_KEYS,
  requiredKeys: readonly string[] = ['message', 'reason'],
): ErrorDetailPolicy {
  return Object.freeze({ reasons, allowedKeys, requiredKeys });
}

/** Pinned OpenAPI mutation-error selector members and their reason enums. */
const ERROR_DETAIL_POLICIES: Readonly<Record<string, ErrorDetailPolicy>> = Object.freeze({
  adEligibilityError: errorPolicy(['AD_INELIGIBLE'], MARKET_ERROR_KEYS),
  applicableMarketplacesError: errorPolicy(['APPLICABLE_MARKETPLACES_MISMATCH_ERROR']),
  asinOwnershipError: errorPolicy(['ASIN_NOT_OWNED_BY_AUTHOR']),
  biddingError: errorPolicy([
    'BID_AUDIENCES_MORE_THAN_ALLOWED', 'BID_GT_BUDGET', 'BID_INVALID_AUDIENCE_ID',
    'BID_INVALID_AUDIENCE_SEGMENT_TYPE', 'BID_INVALID_PLACEMENT',
    'BID_INVALID_SHOPPER_COHORT_TYPE', 'BID_MISSING_AUDIENCES',
    'BID_OUT_OF_MARKET_PLACE_RANGE', 'BID_SHOPPER_COHORTS_MORE_THAN_ALLOWED',
  ], ['cause', 'lowerLimit', 'marketplace', 'message', 'reason', 'upperLimit']),
  billingError: errorPolicy([
    'ADVERTISER_BILLING_SETUP_INCOMPLETE', 'ADVERTISER_SUSPENDED',
    'BILLING_ACCOUNT_NOT_FOUND', 'EXPIRED_PAYMENT_METHOD', 'PAYMENT_PROFILE_NOT_FOUND',
    'VETTING_FAILURE',
  ]),
  budgetError: errorPolicy([
    'BUDGETING_POLICY_INVALID', 'BUDGET_CURRENCY_DOES_NOT_MATCH_MARKETPLACE_SETTINGS',
    'BUDGET_LT_DEFAULT_BIDS', 'BUDGET_LT_KEYWORD_BIDS', 'BUDGET_LT_PREDEFINED_TARGET_BIDS',
    'BUDGET_OUT_OF_MARKET_PLACE_RANGE', 'BUDGET_TOO_HIGH', 'BUDGET_TOO_LOW',
    'MISSING_BUDGETING_POLICY', 'MISSING_IN_BUDGET_FLAG',
  ], ['cause', 'lowerLimit', 'message', 'reason', 'upperLimit']),
  currencyError: errorPolicy([
    'CANNOT_UPDATE_CURRENCY', 'CURRENCY_NOT_MATCHING_PREFERRED_CURRENCY',
    'CURRENCY_NOT_SUPPORTED', 'PREFERRED_CURRENCY_NOT_SET',
  ]),
  dateError: errorPolicy([
    'END_DATE_EARLIER_THAN_TODAY', 'END_DATE_LATER_THAN_MAXIMUM', 'INVALID_DATE',
    'START_DATE_AFTER_END_DATE', 'START_DATE_EARLIER_THAN_TODAY',
    'START_DATE_LATER_THAN_MAXIMUM', 'UPDATING_ENDED_CAMPAIGN_WITHOUT_EXTENSION',
    'UPDATING_READ_ONLY_END_DATE', 'UPDATING_READ_ONLY_START_DATE',
  ]),
  duplicateValueError: errorPolicy([
    'DUPLICATE_VALUE', 'MARKETPLACE_ATTRIBUTES_REPEATED', 'NAME_NOT_UNIQUE',
  ], MARKET_ERROR_KEYS),
  entityNotFoundError: errorPolicy(
    ['ENTITY_NOT_FOUND'],
    ['cause', 'entityId', 'entityType', 'message', 'reason'],
    ['entityId', 'entityType', 'message', 'reason'],
  ),
  entityQuotaError: errorPolicy(
    ['NON_ARCHIVED_QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['cause', 'entityType', 'message', 'quota', 'quotaScope', 'reason'],
    ['entityType', 'message', 'reason'],
  ),
  entityStateError: errorPolicy([
    'ARCHIVED_ENTITY_CANNOT_BE_MODIFIED', 'AUTO_TARGETING_CLAUSE_CANNOT_BE_ARCHIVED_MANUALLY',
    'INVALID_STATE_TRANSITION', 'INVALID_TARGET_STATE', 'MARKETPLACE_STATE_CANNOT_BE_ARCHIVED',
    'PARENT_ARCHIVED_FORBIDS_UPDATES', 'PARENT_ENTITY_FORBIDS_CREATION',
    'PARENT_STATUS_FORBIDS_UPDATES_AND_CREATES',
  ], ['cause', 'entityType', 'marketplace', 'message', 'reason'], ['entityType', 'message', 'reason']),
  expressionTypeError: errorPolicy(['UNSUPPORTED_EXPRESSION_TYPE']),
  internalServerError: errorPolicy(['INTERNAL_ERROR']),
  localeError: errorPolicy(['INVALID_LOCALE']),
  malformedValueError: errorPolicy(
    ['BLANK', 'FORBIDDEN_CHARS', 'LEADING_OR_TRAILING_WHITESPACE', 'PATTERN_NOT_MATCHED',
      'TOO_LONG', 'TOO_SHORT'],
    ['cause', 'fragment', 'marketplace', 'message', 'reason'],
  ),
  missingValueError: errorPolicy(['MISSING_VALUE'], MARKET_ERROR_KEYS),
  otherError: errorPolicy(['OTHER_ERROR'], MARKET_ERROR_KEYS),
  parentEntityError: errorPolicy([
    'PARENT_ENTITY_ARCHIVED', 'PARENT_ENTITY_DOES_NOT_TARGET_THESE_MARKETPLACES',
    'PARENT_ENTITY_NOT_FOUND',
  ]),
  productIdentifierError: errorPolicy(['INVALID_ASIN', 'INVALID_SKU'], MARKET_ERROR_KEYS),
  rangeError: errorPolicy(
    ['INVALID_ENUM_VALUE', 'NOT_IN_LIST', 'TOO_HIGH', 'TOO_LOW'],
    ['allowed', 'cause', 'lowerLimit', 'marketplace', 'message', 'reason', 'upperLimit'],
  ),
  targetingClauseSetupError: errorPolicy([
    'AUTO_TARGETING_CLAUSE_CANNOT_BE_CREATED_MANUALLY', 'TARGETING_EXPRESSION_INVALID_VALUE',
    'TARGETING_TYPE_NOT_ALLOWED_FOR_AUTO_TARGETING_CAMPAIGN', 'TYPE_CONFLICT_IN_AD_GROUP',
  ], MARKET_ERROR_KEYS),
  throttledError: errorPolicy(['THROTTLED']),
  unsupportedOperationError: errorPolicy(['UNSUPPORTED_OPERATION']),
});

const ERROR_SELECTOR_KEYS: Readonly<Record<SpWriteRouteKey, readonly string[]>> = Object.freeze({
  'sp.v3.campaigns.update': [
    'biddingError', 'billingError', 'budgetError', 'currencyError', 'dateError',
    'duplicateValueError', 'entityNotFoundError', 'entityQuotaError', 'entityStateError',
    'internalServerError', 'malformedValueError', 'missingValueError', 'otherError',
    'parentEntityError', 'rangeError', 'throttledError',
  ],
  'sp.v3.ad_groups.update': [
    'applicableMarketplacesError', 'biddingError', 'billingError', 'duplicateValueError',
    'entityNotFoundError', 'entityQuotaError', 'entityStateError', 'internalServerError',
    'malformedValueError', 'missingValueError', 'otherError', 'parentEntityError',
    'rangeError', 'throttledError',
  ],
  'sp.v3.keywords.update': [
    'biddingError', 'billingError', 'duplicateValueError', 'entityNotFoundError',
    'entityQuotaError', 'entityStateError', 'internalServerError', 'localeError',
    'malformedValueError', 'missingValueError', 'otherError', 'parentEntityError',
    'rangeError', 'targetingClauseSetupError', 'throttledError',
  ],
  'sp.v3.targets.update': [
    'biddingError', 'billingError', 'duplicateValueError', 'entityNotFoundError',
    'entityQuotaError', 'entityStateError', 'expressionTypeError', 'internalServerError',
    'malformedValueError', 'missingValueError', 'otherError', 'parentEntityError',
    'rangeError', 'targetingClauseSetupError', 'throttledError',
  ],
  'sp.v3.product_ads.update': [
    'adEligibilityError', 'asinOwnershipError', 'billingError', 'duplicateValueError',
    'entityNotFoundError', 'entityQuotaError', 'entityStateError', 'internalServerError',
    'malformedValueError', 'missingValueError', 'otherError', 'parentEntityError',
    'productIdentifierError', 'rangeError', 'throttledError', 'unsupportedOperationError',
  ],
});

const ROUTES: Readonly<Record<SpWriteRouteKey, RouteSpec>> = Object.freeze({
  'sp.v3.campaigns.update': route(
    '/sp/campaigns', 'application/vnd.spCampaign.v3+json', 'campaigns',
    'campaignId', 'campaignIdFilter', ERROR_SELECTOR_KEYS['sp.v3.campaigns.update'],
  ),
  'sp.v3.ad_groups.update': route(
    '/sp/adGroups', 'application/vnd.spAdGroup.v3+json', 'adGroups',
    'adGroupId', 'adGroupIdFilter', ERROR_SELECTOR_KEYS['sp.v3.ad_groups.update'],
  ),
  'sp.v3.keywords.update': route(
    '/sp/keywords', 'application/vnd.spKeyword.v3+json', 'keywords',
    'keywordId', 'keywordIdFilter', ERROR_SELECTOR_KEYS['sp.v3.keywords.update'],
  ),
  'sp.v3.targets.update': route(
    '/sp/targets', 'application/vnd.spTargetingClause.v3+json', 'targetingClauses',
    'targetId', 'targetIdFilter', ERROR_SELECTOR_KEYS['sp.v3.targets.update'],
  ),
  'sp.v3.product_ads.update': route(
    '/sp/productAds', 'application/vnd.spProductAd.v3+json', 'productAds',
    'adId', 'adIdFilter', ERROR_SELECTOR_KEYS['sp.v3.product_ads.update'],
  ),
});

function route(
  path: string,
  mediaType: string,
  requestKey: string,
  idKey: string,
  idFilterKey: string,
  errorSelectorKeys: readonly string[],
): RouteSpec {
  return Object.freeze({
    path,
    mediaType,
    requestKey,
    responseKey: requestKey,
    idKey,
    listPath: `${path}/list`,
    listResponseKey: requestKey,
    idFilterKey,
    errorSelectorKeys,
  });
}

export type SpWriteCompiledCall = Readonly<{
  routeKey: SpWriteRouteKey;
  actions: readonly SpWriteAction[];
  positions: SpWriteProviderCallIntent['positions'];
  providerScope: SpWriteProviderScope;
  mutation: Readonly<{
    path: string;
    mediaType: string;
    requestKey: string;
    responseKey: string;
    idKey: string;
    errorSelectorKeys: readonly string[];
    body: string;
  }>;
  observation: Readonly<{
    path: string;
    mediaType: string;
    responseKey: string;
    idKey: string;
    idFilterKey: string;
  }>;
}>;

export type SpWriteObservationPage = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  nextToken: string | null;
  totalResults: number | null;
}>;

export type SpWriteProviderPositionDraft = SpWriteProviderResult['positions'][number];

export type SpWrite207ParseResult =
  | Readonly<{ kind: 'positions'; positions: readonly SpWriteProviderPositionDraft[] }>
  | Readonly<{ kind: 'ambiguous'; code: string; message: string | null }>;

export function prepareSpWriteCalls(
  rawPlan: unknown,
  hasher: SpWriteSha256Hasher,
): readonly SpWriteCompiledCall[] {
  const plan = verifySpWritePlanFingerprints(rawPlan, hasher);
  assertProviderScope(plan.providerScope);

  const calls: SpWriteCompiledCall[] = [];
  let group: SpWriteAction[] = [];
  let routeKey: SpWriteRouteKey | null = null;

  const flush = (): void => {
    if (routeKey === null || group.length === 0) return;
    for (let offset = 0; offset < group.length; offset += MAX_CALL_SIZE) {
      calls.push(compileCall(plan, routeKey, group.slice(offset, offset + MAX_CALL_SIZE), hasher));
    }
    group = [];
  };

  for (const action of plan.actions) {
    if (routeKey !== action.routeKey) {
      flush();
      routeKey = action.routeKey;
    }
    group.push(action);
  }
  flush();
  return calls;
}

function compileCall(
  plan: SpWritePlan,
  routeKey: SpWriteRouteKey,
  actions: readonly SpWriteAction[],
  hasher: SpWriteSha256Hasher,
): SpWriteCompiledCall {
  if (actions.length < 1 || actions.length > MAX_CALL_SIZE
    || actions.some((action) => action.routeKey !== routeKey)) {
    throw new Error('SP write call must contain 1-100 actions from one route');
  }
  const actionIds = new Set<string>();
  const entityIds = new Set<string>();
  const rows: Readonly<Record<string, unknown>>[] = [];
  const positions: SpWriteProviderCallIntent['positions'][number][] = [];

  actions.forEach((action, requestIndex) => {
    const amazonEntityId = entityId(action);
    if (actionIds.has(action.actionId) || entityIds.has(amazonEntityId)) {
      throw new Error('SP write call repeats an action or Amazon entity');
    }
    actionIds.add(action.actionId);
    entityIds.add(amazonEntityId);
    const row = compileRow(action, plan.providerScope);
    const rowJson = JSON.stringify(row);
    const preimage = JSON.stringify([
      ACTION_REQUEST_DOMAIN,
      plan.providerScope,
      routeKey,
      action.actionId,
      action.fingerprint,
      amazonEntityId,
      rowJson,
    ]);
    const actionRequestFingerprint = digest(preimage, hasher);
    rows.push(row);
    positions.push({
      requestIndex,
      actionId: action.actionId,
      actionFingerprint: action.fingerprint,
      amazonEntityId,
      actionRequestFingerprint,
    });
  });

  const spec = ROUTES[routeKey];
  return Object.freeze({
    routeKey,
    actions: Object.freeze([...actions]),
    positions,
    providerScope: Object.freeze({ ...plan.providerScope }),
    mutation: Object.freeze({
      path: spec.path,
      mediaType: spec.mediaType,
      requestKey: spec.requestKey,
      responseKey: spec.responseKey,
      idKey: spec.idKey,
      errorSelectorKeys: spec.errorSelectorKeys,
      body: JSON.stringify({ [spec.requestKey]: rows }),
    }),
    observation: Object.freeze({
      path: spec.listPath,
      mediaType: spec.mediaType,
      responseKey: spec.listResponseKey,
      idKey: spec.idKey,
      idFilterKey: spec.idFilterKey,
    }),
  });
}

function compileRow(
  action: SpWriteAction,
  scope: SpWriteProviderScope,
): Readonly<Record<string, unknown>> {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update': {
      const row: Record<string, unknown> = { campaignId: action.entity.campaignId };
      if (action.changes.budget !== undefined) {
        assertMoney(action.changes.budget.expected.amount, scope, 'budget');
        row['budget'] = {
          budget: moneyNumber(action.changes.budget.requested.amount, scope, 'budget'),
          budgetType: 'DAILY',
        };
      }
      if (action.changes.state !== undefined) row['state'] = wireState(action.changes.state.requested);
      if (action.changes.placement !== undefined) {
        row['dynamicBidding'] = compileBidding(action.changes.placement.requested);
        const offAmazon = action.changes.placement.requested.offAmazonBudgetControlStrategy;
        if (offAmazon !== null) {
          assertOneOf(offAmazon, ['MAXIMIZE_REACH', 'MINIMIZE_SPEND'], 'off-Amazon strategy');
          row['offAmazonSettings'] = { offAmazonBudgetControlStrategy: offAmazon };
        }
      }
      return Object.freeze(row);
    }
    case 'sp.v3.ad_groups.update': {
      const row: Record<string, unknown> = { adGroupId: action.entity.adGroupId };
      if (action.changes.defaultBid !== undefined) {
        assertMoney(action.changes.defaultBid.expected.amount, scope, 'bid');
        row['defaultBid'] = moneyNumber(action.changes.defaultBid.requested.amount, scope, 'bid');
      }
      if (action.changes.state !== undefined) row['state'] = wireState(action.changes.state.requested);
      return Object.freeze(row);
    }
    case 'sp.v3.keywords.update': {
      const row: Record<string, unknown> = { keywordId: action.entity.keywordId };
      if (action.changes.bid !== undefined) {
        assertMoney(action.changes.bid.expected.amount, scope, 'bid');
        row['bid'] = moneyNumber(action.changes.bid.requested.amount, scope, 'bid');
      }
      if (action.changes.state !== undefined) row['state'] = wireState(action.changes.state.requested);
      return Object.freeze(row);
    }
    case 'sp.v3.targets.update': {
      const row: Record<string, unknown> = { targetId: action.entity.targetId };
      if (action.changes.bid !== undefined) {
        assertMoney(action.changes.bid.expected.amount, scope, 'bid');
        row['bid'] = moneyNumber(action.changes.bid.requested.amount, scope, 'bid');
      }
      if (action.changes.state !== undefined) row['state'] = wireState(action.changes.state.requested);
      return Object.freeze(row);
    }
    case 'sp.v3.product_ads.update':
      return Object.freeze({
        adId: action.entity.productAdId,
        state: wireState(action.changes.state!.requested),
      });
  }
}

function compileBidding(state: SpCompleteCampaignBiddingState): Readonly<Record<string, unknown>> {
  const strategy = strategyToWire(state.strategy);
  const placements: readonly [keyof typeof state.placements, string][] = [
    ['topOfSearch', 'PLACEMENT_TOP'],
    ['productPages', 'PLACEMENT_PRODUCT_PAGE'],
    ['restOfSearch', 'PLACEMENT_REST_OF_SEARCH'],
    ['amazonBusiness', 'SITE_AMAZON_BUSINESS'],
  ];
  const placementBidding = placements.flatMap(([key, placement]) => {
    const percentage = state.placements[key];
    return percentage === null ? [] : [{ placement, percentage }];
  });
  if (state.shopperCohorts.length > 1) {
    throw new Error('SP campaign bidding supports at most one shopper cohort');
  }
  const shopperCohortBidding = state.shopperCohorts.map((cohort) => {
    assertOneOf(cohort.shopperCohortType, ['AUDIENCE_SEGMENT'], 'shopper cohort type');
    if (cohort.audienceSegments.length < 1 || cohort.audienceSegments.length > 1) {
      throw new Error('SP audience cohort requires exactly one audience segment');
    }
    return {
      shopperCohortType: cohort.shopperCohortType,
      percentage: cohort.percentage,
      audienceSegments: cohort.audienceSegments.map((segment) => {
        if (segment.audienceId.length > 20) {
          throw new Error('SP audience ID exceeds the provider maximum length');
        }
        assertOneOf(
          segment.audienceSegmentType,
          ['BEHAVIOR_DYNAMIC', 'SPONSORED_ADS_AMC'],
          'audience segment type',
        );
        return {
          audienceId: segment.audienceId,
          audienceSegmentType: segment.audienceSegmentType,
        };
      }),
    };
  });
  return Object.freeze({ strategy, placementBidding, shopperCohortBidding });
}

export function buildSpWriteObservationBody(
  call: SpWriteCompiledCall,
  nextToken?: string,
): Readonly<Record<string, unknown>> {
  if (nextToken !== undefined && nextToken.length === 0) {
    throw new Error('SP observation next token cannot be empty');
  }
  return Object.freeze({
    maxResults: MAX_CALL_SIZE,
    [call.observation.idFilterKey]: {
      include: call.positions.map((position) => position.amazonEntityId),
    },
    ...(nextToken === undefined ? {} : { nextToken }),
  });
}

export function parseSpWriteObservationPage(
  raw: unknown,
  call: SpWriteCompiledCall,
): SpWriteObservationPage {
  const source = requiredRecord(raw, 'SP observation response');
  assertOnlyKeys(source, [call.observation.responseKey, 'nextToken', 'totalResults'], 'SP observation response');
  const rawRows = source[call.observation.responseKey];
  if (!Array.isArray(rawRows)) throw new Error('SP observation response has no entity array');
  const rows = rawRows.map((row, index) => requiredRecord(row, `SP observation row ${index}`));
  const token = source['nextToken'];
  if (token !== undefined && (typeof token !== 'string' || token.length === 0)) {
    throw new Error('SP observation nextToken is malformed');
  }
  const total = source['totalResults'];
  if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0)) {
    throw new Error('SP observation totalResults is malformed');
  }
  if (total !== undefined && total !== call.positions.length) {
    throw new Error('SP observation totalResults does not match requested positions');
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    nextToken: token === undefined ? null : token as string,
    totalResults: total === undefined ? null : total as number,
  });
}

export function parseSpWriteObservationRows(
  call: SpWriteCompiledCall,
  rawRows: readonly unknown[],
): readonly SpWriteObservedAction[] {
  if (rawRows.length !== call.positions.length) {
    throw new Error('SP observation entity count does not match requested positions');
  }
  const actionById = new Map(call.actions.map((action) => [entityId(action), action]));
  const seen = new Set<string>();
  const parsed = new Map<string, SpWriteObservedAction>();

  rawRows.forEach((raw, index) => {
    const row = requiredRecord(raw, `SP observation row ${index}`);
    const id = requiredString(row[call.observation.idKey], `SP observation row ${index} identity`);
    const action = actionById.get(id);
    if (action === undefined) throw new Error(`SP observation returned an extra entity: ${id}`);
    if (seen.has(id)) throw new Error(`SP observation repeated an entity: ${id}`);
    seen.add(id);
    parsed.set(id, parseObservedAction(action, row, call.providerScope));
  });

  return Object.freeze(call.actions.map((action) => {
    const observed = parsed.get(entityId(action));
    if (observed === undefined) throw new Error(`SP observation omitted entity: ${entityId(action)}`);
    return observed;
  }));
}

function parseObservedAction(
  action: SpWriteAction,
  row: Readonly<Record<string, unknown>>,
  scope: SpWriteProviderScope,
): SpWriteObservedAction {
  const base = {
    routeKey: action.routeKey,
    actionId: action.actionId,
    actionFingerprint: action.fingerprint,
    amazonEntityId: entityId(action),
  };
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.budget === undefined ? {} : {
            budget: parseCampaignBudget(row['budget'], scope),
          }),
          ...(action.changes.state === undefined ? {} : { state: parseState(row['state']) }),
          ...(action.changes.placement === undefined ? {} : {
            placement: parseCompleteCampaignBidding(row),
          }),
        },
      });
    case 'sp.v3.ad_groups.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.defaultBid === undefined ? {} : {
            defaultBid: parseMoney(row['defaultBid'], scope, 'bid'),
          }),
          ...(action.changes.state === undefined ? {} : { state: parseState(row['state']) }),
        },
      });
    case 'sp.v3.keywords.update':
    case 'sp.v3.targets.update':
      return SpWriteObservedAction.parse({
        ...base,
        values: {
          ...(action.changes.bid === undefined ? {} : { bid: parseMoney(row['bid'], scope, 'bid') }),
          ...(action.changes.state === undefined ? {} : { state: parseState(row['state']) }),
        },
      });
    case 'sp.v3.product_ads.update':
      return SpWriteObservedAction.parse({ ...base, values: { state: parseState(row['state']) } });
  }
}

function parseCampaignBudget(raw: unknown, scope: SpWriteProviderScope) {
  const budget = requiredRecord(raw, 'SP campaign budget');
  assertOnlyKeys(budget, ['budget', 'budgetType', 'effectiveBudget'], 'SP campaign budget');
  if (budget['budgetType'] !== 'DAILY') {
    throw new Error('SP campaign observation budgetType must be DAILY');
  }
  return parseMoney(budget['budget'], scope, 'budget');
}

function parseCompleteCampaignBidding(
  campaign: Readonly<Record<string, unknown>>,
): SpCompleteCampaignBiddingState {
  const dynamic = requiredRecord(campaign['dynamicBidding'], 'SP campaign dynamicBidding');
  assertOnlyKeys(
    dynamic,
    ['strategy', 'placementBidding', 'shopperCohortBidding'],
    'SP campaign dynamicBidding',
  );
  const strategy = strategyFromWire(dynamic['strategy']);
  const placements: SpCompleteCampaignBiddingState['placements'] = {
    topOfSearch: null,
    productPages: null,
    restOfSearch: null,
    amazonBusiness: null,
  };
  const placementRows = optionalArray(dynamic, 'placementBidding', 'SP placementBidding');
  const seenPlacements = new Set<string>();
  for (const [index, raw] of placementRows.entries()) {
    const row = requiredRecord(raw, `SP placementBidding row ${index}`);
    assertOnlyKeys(row, ['placement', 'percentage'], `SP placementBidding row ${index}`);
    const placement = requiredString(row['placement'], 'SP placement');
    if (seenPlacements.has(placement)) throw new Error(`SP campaign repeats placement ${placement}`);
    seenPlacements.add(placement);
    const percentage = requiredPercentage(row['percentage'], 'SP placement percentage');
    switch (placement) {
      case 'PLACEMENT_TOP': placements.topOfSearch = percentage; break;
      case 'PLACEMENT_PRODUCT_PAGE': placements.productPages = percentage; break;
      case 'PLACEMENT_REST_OF_SEARCH': placements.restOfSearch = percentage; break;
      case 'SITE_AMAZON_BUSINESS': placements.amazonBusiness = percentage; break;
      default: throw new Error(`SP campaign has unknown placement ${placement}`);
    }
  }

  const cohortRows = optionalArray(dynamic, 'shopperCohortBidding', 'SP shopperCohortBidding');
  if (cohortRows.length > 1) throw new Error('SP campaign has more than one shopper cohort');
  const shopperCohorts = cohortRows.map((raw, index) => {
    const row = requiredRecord(raw, `SP shopper cohort ${index}`);
    assertOnlyKeys(
      row,
      ['shopperCohortType', 'percentage', 'audienceSegments'],
      `SP shopper cohort ${index}`,
    );
    const shopperCohortType = requiredString(row['shopperCohortType'], 'SP shopper cohort type');
    assertOneOf(shopperCohortType, ['AUDIENCE_SEGMENT'], 'shopper cohort type');
    const audienceRows = requiredArray(row, 'audienceSegments', 'SP audienceSegments');
    if (audienceRows.length !== 1) throw new Error('SP audience cohort requires exactly one segment');
    const audienceSegments = audienceRows.map((rawSegment, segmentIndex) => {
      const segment = requiredRecord(rawSegment, `SP audience segment ${segmentIndex}`);
      assertOnlyKeys(segment, ['audienceId', 'audienceSegmentType'], `SP audience segment ${segmentIndex}`);
      const audienceId = requiredString(segment['audienceId'], 'SP audience ID');
      if (audienceId.length > 20) throw new Error('SP audience ID exceeds the provider maximum length');
      const audienceSegmentType = requiredString(segment['audienceSegmentType'], 'SP audience segment type');
      assertOneOf(
        audienceSegmentType,
        ['BEHAVIOR_DYNAMIC', 'SPONSORED_ADS_AMC'],
        'audience segment type',
      );
      return { audienceId, audienceSegmentType };
    }).sort((left, right) =>
      `${left.audienceSegmentType}:${left.audienceId}`.localeCompare(
        `${right.audienceSegmentType}:${right.audienceId}`,
      ));
    return {
      shopperCohortType,
      percentage: requiredPercentage(row['percentage'], 'SP shopper cohort percentage'),
      audienceSegments,
    };
  }).sort((left, right) => JSON.stringify([
    left.shopperCohortType,
    left.audienceSegments.map((segment) => `${segment.audienceSegmentType}:${segment.audienceId}`),
  ]).localeCompare(JSON.stringify([
    right.shopperCohortType,
    right.audienceSegments.map((segment) => `${segment.audienceSegmentType}:${segment.audienceId}`),
  ])));

  const offAmazonRaw = campaign['offAmazonSettings'];
  let offAmazonBudgetControlStrategy: string | null = null;
  if (offAmazonRaw !== undefined) {
    const offAmazon = requiredRecord(offAmazonRaw, 'SP campaign offAmazonSettings');
    assertOnlyKeys(offAmazon, ['offAmazonBudgetControlStrategy'], 'SP campaign offAmazonSettings');
    offAmazonBudgetControlStrategy = requiredString(
      offAmazon['offAmazonBudgetControlStrategy'],
      'SP campaign off-Amazon strategy',
    );
    assertOneOf(
      offAmazonBudgetControlStrategy,
      ['MAXIMIZE_REACH', 'MINIMIZE_SPEND'],
      'off-Amazon strategy',
    );
  }

  return {
    strategy,
    placements,
    shopperCohorts,
    offAmazonBudgetControlStrategy,
  };
}

export function parseSpWrite207(
  raw: unknown,
  call: SpWriteCompiledCall,
): SpWrite207ParseResult {
  try {
    const source = requiredRecord(raw, 'SP write 207 response');
    assertOnlyKeys(source, [call.mutation.responseKey], 'SP write 207 response');
    const envelope = requiredRecord(
      source[call.mutation.responseKey],
      `SP write 207 ${call.mutation.responseKey} envelope`,
    );
    assertOnlyKeys(envelope, ['success', 'error'], 'SP write 207 envelope');
    const successes = optionalArray(envelope, 'success', 'SP write 207 success');
    const failures = optionalArray(envelope, 'error', 'SP write 207 error');
    const positions = new Map<number, SpWriteProviderPositionDraft>();

    for (const rawSuccess of successes) {
      const success = requiredRecord(rawSuccess, 'SP write 207 success row');
      assertOnlyKeys(
        success,
        // The OpenAPI makes a full entity optional. Version 1 rejects it even
        // when object-shaped rather than trusting a partial entity codec.
        ['index', call.mutation.idKey],
        'SP write 207 success row',
      );
      const index = responseIndex(success['index'], call.positions.length);
      if (positions.has(index)) throw new Error(`SP write 207 repeats index ${index}`);
      const providerEntityId = requiredString(
        success[call.mutation.idKey],
        `SP write 207 success ${call.mutation.idKey}`,
      );
      const intended = call.positions[index]!;
      if (providerEntityId !== intended.amazonEntityId) {
        throw new Error(`SP write 207 success identity mismatch at index ${index}`);
      }
      positions.set(index, {
        requestIndex: index,
        actionId: intended.actionId,
        actionFingerprint: intended.actionFingerprint,
        actionRequestFingerprint: intended.actionRequestFingerprint,
        outcome: 'accepted',
        providerEntityId,
        code: null,
        message: null,
      });
    }

    for (const rawFailure of failures) {
      const failure = requiredRecord(rawFailure, 'SP write 207 error row');
      assertOnlyKeys(failure, ['index', 'errors'], 'SP write 207 error row');
      const index = responseIndex(failure['index'], call.positions.length);
      if (positions.has(index)) throw new Error(`SP write 207 repeats index ${index}`);
      const errorRows = requiredArray(failure, 'errors', 'SP write 207 error details');
      if (errorRows.length < 1) throw new Error('SP write 207 error row has no details');
      let code: string | null = null;
      errorRows.forEach((rawDetail, detailIndex) => {
        const detail = requiredRecord(rawDetail, `SP write 207 error detail ${detailIndex}`);
        assertOnlyKeys(detail, ['errorType', 'errorValue'], `SP write 207 error detail ${detailIndex}`);
        requiredString(detail['errorType'], 'SP write 207 error type');
        const staticCode = validateErrorSelector(
          detail['errorValue'],
          call.mutation.errorSelectorKeys,
        );
        if (code === null) code = staticCode;
      });
      const intended = call.positions[index]!;
      positions.set(index, {
        requestIndex: index,
        actionId: intended.actionId,
        actionFingerprint: intended.actionFingerprint,
        actionRequestFingerprint: intended.actionRequestFingerprint,
        outcome: 'authoritative_rejected',
        providerEntityId: null,
        code,
        message: null,
      });
    }

    if (positions.size !== call.positions.length) {
      throw new Error(`SP write 207 accounted for ${positions.size} of ${call.positions.length} positions`);
    }
    return {
      kind: 'positions',
      positions: Object.freeze(call.positions.map((_, index) => positions.get(index)!)),
    };
  } catch {
    return {
      kind: 'ambiguous',
      code: 'MALFORMED_INDEXED_RESPONSE',
      // Malformed-response explanations can contain provider-controlled key
      // names or values. Preserve only the static classification.
      message: null,
    };
  }
}

function assertProviderScope(scope: SpWriteProviderScope): MoneyRule {
  const moneyRule = MONEY_RULES[scope.marketplaceId];
  if (moneyRule === undefined) throw new Error(`Unsupported Amazon marketplace: ${scope.marketplaceId}`);
  if (scope.region !== moneyRule.region || scope.currencyCode !== moneyRule.currencyCode) {
    throw new Error('SP write provider scope region or currency does not match its marketplace');
  }
  if (!Number.isInteger(moneyRule.scale) || moneyRule.scale < 0 || moneyRule.scale > 6) {
    throw new Error('SP write marketplace has an unsupported currency scale');
  }
  return moneyRule;
}

function moneyNumber(
  amount: string,
  scope: SpWriteProviderScope,
  kind: 'bid' | 'budget',
): number {
  assertMoney(amount, scope, kind);
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || JSON.stringify(numeric) !== amount) {
    throw new Error(`SP ${kind} cannot be represented as its exact JSON numeric token`);
  }
  return numeric;
}

function assertMoney(
  amount: string,
  scope: SpWriteProviderScope,
  kind: 'bid' | 'budget',
): void {
  const moneyRule = assertProviderScope(scope);
  const parsed = decimalAtScale(amount, moneyRule.scale);
  const minimum = decimalAtScale(kind === 'bid' ? moneyRule.bidMin : moneyRule.budgetMin, moneyRule.scale);
  const maximum = decimalAtScale(kind === 'bid' ? moneyRule.bidMax : moneyRule.budgetMax, moneyRule.scale);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`SP ${kind} is outside marketplace bounds`);
  }
}

function decimalAtScale(value: string, scale: number): bigint {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{0,5}[1-9])?$/.test(value)) {
    throw new Error('SP money must use canonical decimal syntax');
  }
  const [integer, fractional = ''] = value.split('.');
  if (fractional.length > scale) throw new Error('SP money exceeds the marketplace currency scale');
  return BigInt(`${integer}${fractional.padEnd(scale, '0')}`);
}

function parseMoney(
  raw: unknown,
  scope: SpWriteProviderScope,
  kind: 'bid' | 'budget',
): Readonly<{ amount: string; currencyCode: string }> {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`SP observed ${kind} is not a finite number`);
  }
  const amount = JSON.stringify(raw);
  if (amount === undefined || amount.includes('e')) {
    throw new Error(`SP observed ${kind} has no canonical decimal representation`);
  }
  assertMoney(amount, scope, kind);
  return { amount, currencyCode: scope.currencyCode };
}

function digest(preimage: string, hasher: SpWriteSha256Hasher): string {
  if (hasher.algorithm !== 'sha256') throw new Error('SP write fingerprints require SHA-256');
  const result = hasher.digest(preimage);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('SP write hasher returned a non-canonical digest');
  return result;
}

function entityId(action: SpWriteAction): string {
  switch (action.routeKey) {
    case 'sp.v3.campaigns.update': return action.entity.campaignId;
    case 'sp.v3.ad_groups.update': return action.entity.adGroupId;
    case 'sp.v3.keywords.update': return action.entity.keywordId;
    case 'sp.v3.targets.update': return action.entity.targetId;
    case 'sp.v3.product_ads.update': return action.entity.productAdId;
  }
}

function wireState(state: 'enabled' | 'paused'): 'ENABLED' | 'PAUSED' {
  return state === 'enabled' ? 'ENABLED' : 'PAUSED';
}

function parseState(raw: unknown): 'enabled' | 'paused' {
  if (raw === 'ENABLED') return 'enabled';
  if (raw === 'PAUSED') return 'paused';
  throw new Error('SP observed state is not mutable');
}

function strategyToWire(value: SpCompleteCampaignBiddingState['strategy']): string {
  switch (value) {
    case 'legacy_for_sales': return 'LEGACY_FOR_SALES';
    case 'auto_for_sales': return 'AUTO_FOR_SALES';
    case 'manual': return 'MANUAL';
    case 'rule_based': return 'RULE_BASED';
  }
}

function strategyFromWire(raw: unknown): SpCompleteCampaignBiddingState['strategy'] {
  switch (raw) {
    case 'LEGACY_FOR_SALES': return 'legacy_for_sales';
    case 'AUTO_FOR_SALES': return 'auto_for_sales';
    case 'MANUAL': return 'manual';
    case 'RULE_BASED': return 'rule_based';
    default: throw new Error('SP campaign has unknown bidding strategy');
  }
}

function responseIndex(raw: unknown, submitted: number): number {
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) >= submitted) {
    throw new Error('SP write 207 index is outside the submitted range');
  }
  return raw as number;
}

const ERROR_MARKETPLACES: readonly string[] = [
  'AE', 'AU', 'BR', 'CA', 'DE', 'EG', 'ES', 'FR', 'IN', 'IT', 'JP', 'MX',
  'NL', 'PL', 'SA', 'SE', 'SG', 'TR', 'UK', 'US',
] as const;
const ERROR_ENTITY_TYPES: readonly string[] = [
  'AD_GROUP', 'CAMPAIGN', 'CAMPAIGN_NEGATIVE_KEYWORD',
  'CAMPAIGN_NEGATIVE_TARGETING_CLAUSE', 'KEYWORD', 'NEGATIVE_KEYWORD',
  'NEGATIVE_TARGETING_CLAUSE', 'PRODUCT_AD', 'TARGETING_CLAUSE',
] as const;

function validateErrorSelector(
  raw: unknown,
  allowedSelectorKeys: readonly string[],
): string {
  const selector = requiredRecord(raw, 'SP write 207 error selector');
  const selectorKeys = Object.keys(selector);
  if (selectorKeys.length !== 1) {
    throw new Error('SP write 207 error selector must contain exactly one member');
  }
  const selectorKey = selectorKeys[0]!;
  if (!allowedSelectorKeys.includes(selectorKey)) {
    throw new Error('SP write 207 error selector is not valid for this route');
  }
  const policy = ERROR_DETAIL_POLICIES[selectorKey];
  if (policy === undefined) throw new Error('SP write 207 error selector has no pinned policy');
  const staticCode = selectorKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

  const detail = requiredRecord(selector[selectorKey], 'SP write 207 selected error');
  assertOnlyKeys(detail, policy.allowedKeys, 'SP write 207 selected error');
  for (const requiredKey of policy.requiredKeys) {
    if (!Object.hasOwn(detail, requiredKey)) {
      throw new Error('SP write 207 selected error omits a required member');
    }
  }
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'cause') {
      const cause = requiredRecord(value, 'SP write 207 error cause');
      assertOnlyKeys(cause, ['location', 'trigger'], 'SP write 207 error cause');
      requiredString(cause['location'], 'SP write 207 error cause location');
      if (cause['trigger'] !== undefined) {
        requiredString(cause['trigger'], 'SP write 207 error cause trigger');
      }
    } else if (key === 'allowed') {
      const allowed = requiredArray(detail, key, 'SP write 207 error allowed values');
      allowed.forEach((candidate) => requiredString(candidate, 'SP write 207 allowed value'));
    } else {
      requiredString(value, `SP write 207 error ${key}`);
    }
  }

  const reason = requiredString(detail['reason'], 'SP write 207 error reason');
  if (!policy.reasons.includes(reason)) throw new Error('SP write 207 error reason is unknown');
  const marketplace = detail['marketplace'];
  if (marketplace !== undefined) {
    const value = requiredString(marketplace, 'SP write 207 error marketplace');
    if (!ERROR_MARKETPLACES.includes(value)) {
      throw new Error('SP write 207 error marketplace is unknown');
    }
  }
  const entityType = detail['entityType'];
  if (entityType !== undefined) {
    const value = requiredString(entityType, 'SP write 207 error entity type');
    if (!ERROR_ENTITY_TYPES.includes(value)) {
      throw new Error('SP write 207 error entity type is unknown');
    }
  }
  const quotaScope = detail['quotaScope'];
  if (quotaScope !== undefined && quotaScope !== 'ACCOUNT' && quotaScope !== 'PARENT_ENTITY') {
    throw new Error('SP write 207 error quota scope is unknown');
  }
  return staticCode;
}

function requiredPercentage(raw: unknown, label: string): number {
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > 900) {
    throw new Error(`${label} must be an integer from 0 through 900`);
  }
  return raw as number;
}

function requiredRecord(raw: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} is not an object`);
  }
  return raw as Readonly<Record<string, unknown>>;
}

function requiredString(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error(`${label} is not a nonempty string`);
  return raw;
}

function requiredArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): readonly unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function optionalArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): readonly unknown[] {
  const value = source[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function assertOnlyKeys(
  source: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(source).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown key ${unknown}`);
}

function assertOneOf(value: string, allowed: readonly string[], label: string): void {
  if (!allowed.includes(value)) throw new Error(`SP ${label} has an unsupported value`);
}
