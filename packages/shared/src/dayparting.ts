/** Amazon Marketing Stream ledger, hourly facts, and read-only schedule proposals. */
import { z } from 'zod';
import { AdProduct, AmazonId, CurrencyCode, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative();

export const MarketingStreamDataset = z.enum([
  'traffic',
  'conversion',
  'budget_usage',
]);
export type MarketingStreamDataset = z.infer<typeof MarketingStreamDataset>;

/** Dataset identifiers carried by Amazon Marketing Stream provider records. */
export const AmazonMarketingStreamDatasetId = z.enum([
  'sp-traffic',
  'sp-conversion',
  'sb-traffic',
  'sb-conversion',
  'sd-traffic',
  'sd-conversion',
  'budget-usage',
]);
export type AmazonMarketingStreamDatasetId = z.infer<
  typeof AmazonMarketingStreamDatasetId
>;

/**
 * Immutable provider identity retained beside the raw ledger event.
 *
 * `bindingId` is the tenant-routing decision made before ingestion. Keeping it
 * on the event makes later replay independent of profile aliases or renamed
 * Amazon accounts.
 */
export const MarketingStreamProviderIdentity = z.object({
  bindingId: Uuid,
  subscriptionId: z.string().min(1),
  datasetId: AmazonMarketingStreamDatasetId,
  advertiserId: AmazonId,
  marketplaceId: AmazonId,
  eventId: z.string().min(1),
});
export type MarketingStreamProviderIdentity = z.infer<
  typeof MarketingStreamProviderIdentity
>;

export const MarketingStreamSubscriptionBinding = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  subscriptionId: z.string().min(1),
  datasetId: AmazonMarketingStreamDatasetId,
  advertiserId: AmazonId,
  marketplaceId: AmazonId,
  active: z.boolean(),
});
export type MarketingStreamSubscriptionBinding = z.infer<
  typeof MarketingStreamSubscriptionBinding
>;

export const MarketingStreamLedgerEvent = z.object({
  profileId: Uuid,
  messageId: z.string().min(1),
  dataset: MarketingStreamDataset,
  adProduct: AdProduct,
  eventTime: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  revision: z.number().int().nonnegative(),
  payloadHash: z.string().min(1),
  rawPayload: z.record(z.string(), z.unknown()),
  provider: MarketingStreamProviderIdentity.optional(),
});
export type MarketingStreamLedgerEvent = z.infer<typeof MarketingStreamLedgerEvent>;

/**
 * One transport-neutral unit delivered through the private SQS queue.
 *
 * The Amazon subscription/fanout boundary is responsible for mapping provider
 * records into this explicit contract. The worker never infers an internal
 * tenant or profile from a campaign id, and every event repeats the profile id
 * so a mixed-profile batch is rejected before any ledger write.
 */
export const MarketingStreamBatchEnvelope = z.object({
  schema: z.literal('wizard-ads.marketing-stream-batch.v1'),
  orgId: Uuid,
  profileId: Uuid,
  events: z.array(MarketingStreamLedgerEvent).min(1),
}).superRefine((envelope, context) => {
  envelope.events.forEach((event, index) => {
    if (event.profileId !== envelope.profileId) {
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'profileId'],
        message: 'event profile does not match envelope profile',
      });
    }
  });
});
export type MarketingStreamBatchEnvelope = z.infer<typeof MarketingStreamBatchEnvelope>;

export const HourSettlingState = z.enum(['settling', 'settled', 'revised']);
export type HourSettlingState = z.infer<typeof HourSettlingState>;

export const MarketingStreamHourlyFact = z.object({
  profileId: Uuid,
  adProduct: AdProduct,
  campaignId: AmazonId,
  utcHour: z.iso.datetime(),
  profileTimeZone: z.string().min(1),
  localDate: IsoDate,
  localHour: z.number().int().min(0).max(23),
  localDayOfWeek: z.number().int().min(0).max(6),
  currencyCode: CurrencyCode,
  impressions: count,
  clicks: count,
  cost: metric,
  purchases: count,
  sales: metric,
  budgetUsagePercent: z.number().min(0).nullable(),
  budgetCapped: z.boolean(),
  settlingState: HourSettlingState,
  sourceEvents: count,
});
export type MarketingStreamHourlyFact = z.infer<typeof MarketingStreamHourlyFact>;

export const DaypartingScheduleBlock = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  adjustmentPercent: z.number(),
  confidence: z.number().min(0).max(1),
});
export type DaypartingScheduleBlock = z.infer<typeof DaypartingScheduleBlock>;

export const DaypartingScheduleProposal = z.object({
  id: Uuid.optional(),
  profileId: Uuid,
  campaignId: AmazonId,
  baselineLabel: z.string().min(1),
  evidenceStart: IsoDate,
  evidenceEnd: IsoDate,
  settledHours: count,
  blocks: z.array(DaypartingScheduleBlock),
  status: z.enum(['proposed', 'accepted', 'dismissed', 'exported']),
});
export type DaypartingScheduleProposal = z.infer<typeof DaypartingScheduleProposal>;

export const MarketingStreamNormalizationCounts = z.object({
  receivedMessages: count,
  duplicateMessages: count,
  revisedMessages: count,
  refusedMessages: count,
  normalizedRows: count,
});
export type MarketingStreamNormalizationCounts = z.infer<
  typeof MarketingStreamNormalizationCounts
>;
