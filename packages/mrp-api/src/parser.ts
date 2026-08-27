import { z } from 'zod';
import { MrpParseError, MrpToolCallError } from './errors.js';
import type {
  MrpPeriod,
  MrpProductEconomics,
  MrpProductMetrics,
  MrpSeller,
} from './types.js';

const recordSchema = z.record(z.string(), z.unknown());
const isoDateSchema = z.string().transform((value, context) => {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  const parsed = match?.[1] === undefined ? null : new Date(`${match[1]}T00:00:00Z`);
  if (
    !match?.[1]
    || parsed === null
    || Number.isNaN(parsed.valueOf())
    || parsed.toISOString().slice(0, 10) !== match[1]
  ) {
    context.addIssue({ code: 'custom', message: 'expected an ISO date' });
    return z.NEVER;
  }
  return match[1];
});
const numericValue = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    context.addIssue({ code: 'custom', message: 'expected a finite number or numeric string' });
    return z.NEVER;
  }
  return parsed;
});

const productDocumentSchema = z.object({
  product: z.object({
    asin: z.string().min(1),
  }).passthrough(),
  period: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
    days: numericValue.nullish(),
    complete: z.boolean().nullish(),
    data_available_through: recordSchema.nullish(),
    incomplete_sources: z.array(z.string()).nullish(),
    note: z.string().nullish(),
  }).passthrough(),
}).passthrough();

const FIELD_ALIASES = {
  salePrice: ['sale_price', 'selling_price', 'average_sale_price', 'avg_sale_price', 'unit_price'],
  cogs: ['cogs', 'cost_of_goods', 'cost_of_goods_sold', 'product_cost'],
  fbaFees: ['fba_fees', 'fba_fee', 'fulfillment_fees', 'fulfilment_fees'],
  referralFees: ['referral_fees', 'referral_fee'],
  otherFees: ['other_fees', 'other_fee', 'additional_fees'],
  margin: ['margin', 'profit_margin', 'net_margin', 'net_profit_margin'],
  ltvRevenue: ['ltv_revenue', 'lifetime_revenue', 'lifetime_value', 'customer_ltv'],
  ltvOrders: ['ltv_orders', 'lifetime_orders', 'lifetime_order_count'],
  repeatRate: ['repeat_rate', 'repeat_purchase_rate', 'repeat_order_rate'],
  currency: ['currency', 'currency_code'],
} as const;

function canonicalKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

function ownResult(value: unknown): unknown {
  const parsed = recordSchema.safeParse(value);
  if (parsed.success && Object.prototype.hasOwnProperty.call(parsed.data, 'result')) {
    return parsed.data['result'];
  }
  return value;
}

function prosePayload(value: unknown): string {
  const unwrapped = ownResult(value);
  if (typeof unwrapped === 'string') return unwrapped;
  if (Array.isArray(unwrapped)) {
    const parts = unwrapped.flatMap((part) => {
      try {
        return [prosePayload(part)];
      } catch {
        return [];
      }
    });
    if (parts.length > 0) return parts.join('\n');
  }
  throw new MrpParseError('MRP seller result is not prose text');
}

function sellerFields(segments: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const segment of segments) {
    const separator = segment.indexOf(':');
    if (separator < 0) continue;
    const key = canonicalKey(segment.slice(0, separator).trim());
    const value = segment.slice(separator + 1).trim();
    if (key && value) fields.set(key, value);
  }
  return fields;
}

/** Parse one numbered seller line; headings and malformed lines are ignored. */
export function parseSellerLine(line: string): MrpSeller | null {
  const segments = line.split('|').map((segment) => segment.trim());
  const heading = /^(\d+)\.\s*(.+)$/.exec(segments[0] ?? '');
  if (!heading?.[1] || !heading[2]?.trim()) return null;
  const fields = sellerFields(segments.slice(1));
  const sellerIdText = fields.get('seller_id');
  if (!sellerIdText || !/^\d+$/.test(sellerIdText)) return null;
  const sellerId = Number(sellerIdText);
  if (!Number.isSafeInteger(sellerId)) return null;
  return {
    number: Number(heading[1]),
    name: heading[2].trim(),
    sellerId,
    sellingPartnerId: fields.get('selling_partner_id') ?? null,
    region: fields.get('region') ?? null,
    access: fields.get('access') ?? null,
  };
}

/** Parse the live get_sellers prose while accounting for every nonblank line. */
export function parseSellers(value: unknown): { sellers: MrpSeller[]; ignoredLines: number } {
  const lines = prosePayload(value).split(/\r?\n/).filter((line) => line.trim() !== '');
  const sellers = lines.flatMap((line) => {
    const seller = parseSellerLine(line);
    return seller === null ? [] : [seller];
  });
  if (sellers.length === 0) throw new MrpParseError('MRP seller result contains no parseable sellers');
  return { sellers, ignoredLines: lines.length - sellers.length };
}

function providerMessage(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function productDocument(value: unknown): Record<string, unknown> {
  let unwrapped = ownResult(value);
  for (let attempt = 0; attempt < 2 && typeof unwrapped === 'string'; attempt += 1) {
    const text = unwrapped;
    try {
      unwrapped = JSON.parse(text) as unknown;
    } catch {
      throw new MrpToolCallError(`MRP product metrics failed: ${providerMessage(text)}`);
    }
    unwrapped = ownResult(unwrapped);
  }
  const parsed = recordSchema.safeParse(unwrapped);
  if (!parsed.success) throw new MrpParseError('MRP product metrics result is not a JSON document');
  return parsed.data;
}

interface NamedValue {
  key: string;
  value: unknown;
}

function namedValues(value: unknown, found: NamedValue[] = []): NamedValue[] {
  if (Array.isArray(value)) {
    for (const item of value) namedValues(item, found);
    return found;
  }
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return found;
  for (const [key, nested] of Object.entries(parsed.data)) {
    found.push({ key: canonicalKey(key), value: nested });
    namedValues(nested, found);
  }
  return found;
}

function numericLeaf(value: unknown): number | null {
  const direct = numericValue.safeParse(value);
  if (direct.success) return direct.data;
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return null;
  for (const key of ['current', 'value', 'amount', 'actual', 'total']) {
    const candidate = parsed.data[key];
    const number = numericValue.safeParse(candidate);
    if (number.success) return number.data;
  }
  return null;
}

function optionalMetric(values: readonly NamedValue[], aliases: readonly string[]): number | null {
  for (const alias of aliases) {
    for (const field of values) {
      if (field.key !== alias) continue;
      const parsed = numericLeaf(field.value);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function optionalCurrency(values: readonly NamedValue[]): string | null {
  for (const alias of FIELD_ALIASES.currency) {
    for (const field of values) {
      if (field.key !== alias || typeof field.value !== 'string') continue;
      const currency = field.value.trim().toUpperCase();
      if (/^[A-Z]{3}$/.test(currency)) return currency;
    }
  }
  return null;
}

function parseAvailability(value: Record<string, unknown> | null | undefined): Record<string, string | null> {
  if (!value) return {};
  const dates: Record<string, string | null> = {};
  for (const [source, availableThrough] of Object.entries(value)) {
    if (availableThrough === null || availableThrough === '') {
      dates[canonicalKey(source)] = null;
      continue;
    }
    const parsed = isoDateSchema.safeParse(availableThrough);
    if (!parsed.success) {
      throw new MrpParseError(`MRP period availability for ${source} is not an ISO date`);
    }
    dates[canonicalKey(source)] = parsed.data;
  }
  return dates;
}

function periodFromDocument(period: z.infer<typeof productDocumentSchema>['period']): MrpPeriod {
  return {
    from: period.from,
    to: period.to,
    days: period.days ?? null,
    complete: period.complete ?? null,
    dataAvailableThrough: parseAvailability(period.data_available_through),
    incompleteSources: period.incomplete_sources ?? [],
    note: period.note ?? null,
  };
}

/**
 * Parse the live single-ASIN product document.
 *
 * Only column-compatible metrics are projected. Sales, profit, PPC spend, total
 * fees, comparison data, and every future beta field remain losslessly available
 * in details rather than being assigned a false database meaning.
 */
export function parseProductMetrics(value: unknown, expectedAsin?: string): MrpProductMetrics {
  const document = productDocument(value);
  const parsed = productDocumentSchema.safeParse(document);
  if (!parsed.success) throw new MrpParseError('MRP product metrics document has no valid product/period');
  const asin = parsed.data.product.asin.trim().toUpperCase();
  if (expectedAsin && asin !== expectedAsin.trim().toUpperCase()) {
    throw new MrpParseError(`MRP returned ASIN ${asin} for requested ASIN ${expectedAsin.trim().toUpperCase()}`);
  }

  const currentDocument = Object.fromEntries(
    Object.entries(document).filter(([key]) => canonicalKey(key) !== 'comparison_period'),
  );
  const values = namedValues(currentDocument);
  const product: MrpProductEconomics = {
    asin,
    salePrice: optionalMetric(values, FIELD_ALIASES.salePrice),
    cogs: optionalMetric(values, FIELD_ALIASES.cogs),
    fbaFees: optionalMetric(values, FIELD_ALIASES.fbaFees),
    referralFees: optionalMetric(values, FIELD_ALIASES.referralFees),
    otherFees: optionalMetric(values, FIELD_ALIASES.otherFees),
    margin: optionalMetric(values, FIELD_ALIASES.margin),
    ltvRevenue: optionalMetric(values, FIELD_ALIASES.ltvRevenue),
    ltvOrders: optionalMetric(values, FIELD_ALIASES.ltvOrders),
    repeatRate: optionalMetric(values, FIELD_ALIASES.repeatRate),
    currency: optionalCurrency(values),
    details: document,
  };
  return { product, period: periodFromDocument(parsed.data.period) };
}
