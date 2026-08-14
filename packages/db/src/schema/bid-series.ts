/**
 * The per-target daily bid series — the bid corridor (WP-28).
 *
 * Mirrors `supabase/migrations/20260814190000_bid_series.sql`. Like the fact
 * tables it partitions by month on `date`, and like them Drizzle neither knows
 * nor needs to: a partitioned table is read and written through its parent, so
 * this definition describes only the parent's columns and the one index a query
 * plans against. The partitions, the BRIN and the RLS are the migration's
 * business.
 *
 * `modifierComponents` is typed rather than left bare jsonb: the corridor's
 * `Max CPC` line is composed from these, and a component set with no shape is a
 * component set the tooltip cannot read back.
 */
import { boolean, date, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { money, ts } from './columns.js';
import { adProfiles, orgs } from './tenancy.js';

/**
 * One modifier that lifts a base bid on the way to a max-potential CPC: a
 * placement, dayparting, an audience. Percentage uplift as Amazon stores it.
 * Structurally identical to `packages/core`'s `ModifierComponent`, restated
 * here because `db` may not import `core` (the dependency points the other way).
 */
export interface BidModifierComponent {
  name: string;
  pct: number;
}

export const bidSeriesDaily = pgTable(
  'bid_series_daily',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    /** The profile's own calendar day, never a timestamp. */
    date: date('date').notNull(),
    campaignId: text('campaign_id').notNull(),
    adGroupId: text('ad_group_id').notNull(),
    targetId: text('target_id').notNull(),
    /** A keyword (true) or a product target (false). */
    isKeyword: boolean('is_keyword').notNull(),
    /** Amazon's suggested-bid corridor for the day. Null where Amazon had none. */
    suggestedBidLow: money('suggested_bid_low', 12, 4),
    suggestedBidMedian: money('suggested_bid_median', 12, 4),
    suggestedBidHigh: money('suggested_bid_high', 12, 4),
    /** The bid in force that day: a step function that only moves when moved. */
    bid: money('bid', 12, 4),
    /** Realized cost per click that day (cost / clicks over the target's facts). */
    cpc: money('cpc', 12, 4),
    /** base bid x combined modifier multiplier: the most a click can cost. */
    maxPotentialCpc: money('max_potential_cpc', 12, 4),
    /** The modifier components that composed `maxPotentialCpc`, in order. */
    modifierComponents: jsonb('modifier_components')
      .$type<BidModifierComponent[]>()
      .notNull()
      .default([]),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (t) => [index('bid_series_daily_profile_date').on(t.profileId, t.date)],
);

export type BidSeriesRow = typeof bidSeriesDaily.$inferSelect;
export type NewBidSeriesRow = typeof bidSeriesDaily.$inferInsert;
