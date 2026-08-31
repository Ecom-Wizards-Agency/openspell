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
const MAX_DIAGNOSTIC_CODE = 160;
const MAX_DIAGNOSTIC_MESSAGE = 512;
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
  entityKey: string;
  listPath: string;
  listResponseKey: string;
  idFilterKey: string;
}>;

const ROUTES: Readonly<Record<SpWriteRouteKey, RouteSpec>> = Object.freeze({
  'sp.v3.campaigns.update': route(
    '/sp/campaigns', 'application/vnd.spCampaign.v3+json', 'campaigns',
    'campaignId', 'campaign', 'campaignIdFilter',
  ),
  'sp.v3.ad_groups.update': route(
    '/sp/adGroups', 'application/vnd.spAdGroup.v3+json', 'adGroups',
    'adGroupId', 'adGroup', 'adGroupIdFilter',
  ),
  'sp.v3.keywords.update': route(
    '/sp/keywords', 'application/vnd.spKeyword.v3+json', 'keywords',
    'keywordId', 'keyword', 'keywordIdFilter',
  ),
  'sp.v3.targets.update': route(
    '/sp/targets', 'application/vnd.spTargetingClause.v3+json', 'targetingClauses',
    'targetId', 'targetingClause', 'targetIdFilter',
  ),
  'sp.v3.product_ads.update': route(
    '/sp/productAds', 'application/vnd.spProductAd.v3+json', 'productAds',
    'adId', 'productAd', 'adIdFilter',
  ),
});

function route(
  path: string,
  mediaType: string,
  requestKey: string,
  idKey: string,
  entityKey: string,
  idFilterKey: string,
): RouteSpec {
  return Object.freeze({
    path,
    mediaType,
    requestKey,
    responseKey: requestKey,
    idKey,
    entityKey,
    listPath: `${path}/list`,
    listResponseKey: requestKey,
    idFilterKey,
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
    entityKey: string;
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
      entityKey: spec.entityKey,
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
        ['index', call.mutation.idKey, call.mutation.entityKey],
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
      let message: string | null = null;
      errorRows.forEach((rawDetail, detailIndex) => {
        const detail = requiredRecord(rawDetail, `SP write 207 error detail ${detailIndex}`);
        assertOnlyKeys(detail, ['errorType', 'errorValue'], `SP write 207 error detail ${detailIndex}`);
        if (!Object.hasOwn(detail, 'errorValue')) {
          throw new Error('SP write 207 error detail has no errorValue');
        }
        const errorType = requiredString(detail['errorType'], 'SP write 207 error type');
        if (code === null) code = sanitizeDiagnostic(errorType, MAX_DIAGNOSTIC_CODE);
        if (message === null && typeof detail['errorValue'] === 'string') {
          message = sanitizeDiagnostic(detail['errorValue'], MAX_DIAGNOSTIC_MESSAGE);
        }
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
        message,
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

function sanitizeDiagnostic(value: string, maximum: number): string | null {
  const withoutControls = [...value].map((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  }).join('');
  const compact = withoutControls
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/\b(?:Atza|amzn1)[A-Za-z0-9._~+/=-]{8,}/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
  return compact.length === 0 ? null : compact;
}
