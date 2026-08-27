/** My Real Profit per-ASIN product economics (WP-44). */
import { bigint, char, date, index, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { adProfiles, orgs } from './tenancy.js';

export type ProductEconomicsDetails = Record<string, unknown>;

const economicsNumber = (name: string) => numeric(name, { mode: 'number' });

export const productEconomics = pgTable(
  'product_economics',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => adProfiles.id, { onDelete: 'cascade' }),
    asin: text('asin').notNull(),
    capturedOn: date('captured_on').notNull(),
    salePrice: economicsNumber('sale_price'),
    cogs: economicsNumber('cogs'),
    fbaFees: economicsNumber('fba_fees'),
    referralFees: economicsNumber('referral_fees'),
    otherFees: economicsNumber('other_fees'),
    margin: economicsNumber('margin'),
    ltvRevenue: economicsNumber('ltv_revenue'),
    ltvOrders: economicsNumber('ltv_orders'),
    repeatRate: economicsNumber('repeat_rate'),
    currency: char('currency', { length: 3 }),
    source: text('source').notNull().default('mrp'),
    details: jsonb('details').$type<ProductEconomicsDetails>().notNull().default({}),
    loadedAt: ts('loaded_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('product_economics_profile_id_asin_captured_on_key').on(
      table.profileId,
      table.asin,
      table.capturedOn,
    ),
    index('product_economics_org_profile_date_idx').on(
      table.orgId,
      table.profileId,
      table.capturedOn,
    ),
  ],
);

export type ProductEconomicsRow = typeof productEconomics.$inferSelect;
export type NewProductEconomics = typeof productEconomics.$inferInsert;
