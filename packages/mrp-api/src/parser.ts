import { z } from 'zod';
import { MrpParseError, MrpToolNotFoundError } from './errors.js';
import type { MrpProductEconomics, MrpTool } from './types.js';

const recordSchema = z.record(z.string(), z.unknown());
const numericValue = z.union([z.number(), z.string()]).transform((value, context) => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    context.addIssue({ code: 'custom', message: 'expected a finite number or numeric string' });
    return z.NEVER;
  }
  return parsed;
});

const FIELD_ALIASES = {
  asin: ['asin', 'amazon_asin', 'product_asin'],
  capturedOn: ['captured_on', 'captured_date', 'as_of_date', 'snapshot_date', 'date'],
  salePrice: ['sale_price', 'selling_price', 'sales_price', 'price'],
  cogs: ['cogs', 'cost_of_goods', 'cost_of_goods_sold', 'product_cost'],
  fbaFees: ['fba_fees', 'fba_fee', 'fulfillment_fees', 'fulfilment_fees'],
  referralFees: ['referral_fees', 'referral_fee'],
  otherFees: ['other_fees', 'other_fee', 'additional_fees'],
  margin: ['margin', 'profit_margin', 'net_margin'],
  ltvRevenue: ['ltv_revenue', 'lifetime_revenue', 'lifetime_value', 'customer_ltv'],
  ltvOrders: ['ltv_orders', 'lifetime_orders', 'lifetime_order_count'],
  repeatRate: ['repeat_rate', 'repeat_purchase_rate', 'repeat_order_rate'],
  currency: ['currency', 'currency_code'],
} as const;

const recognizedKeys: ReadonlySet<string> = new Set(Object.values(FIELD_ALIASES).flat());
const rowWrappers = ['products', 'economics', 'items', 'data', 'results', 'rows'] as const;

function canonicalKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase();
}

function canonicalRecord(value: Record<string, unknown>): Map<string, { key: string; value: unknown }> {
  return new Map(Object.entries(value).map(([key, field]) => [canonicalKey(key), { key, value: field }]));
}

function readAlias(
  fields: Map<string, { key: string; value: unknown }>,
  aliases: readonly string[],
): unknown {
  for (const alias of aliases) {
    const field = fields.get(alias);
    if (field !== undefined) return field.value;
  }
  return undefined;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = numericValue.safeParse(value);
  if (!parsed.success) throw new MrpParseError(`MRP product field ${field} is not numeric`);
  return parsed.data;
}

function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new MrpParseError('MRP product capture date is not text');
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  const parsed = match?.[1] === undefined ? null : new Date(`${match[1]}T00:00:00Z`);
  if (
    !match?.[1] ||
    parsed === null ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== match[1]
  ) {
    throw new MrpParseError('MRP product capture date is not an ISO date');
  }
  return match[1];
}

function optionalCurrency(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new MrpParseError('MRP product currency is not text');
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new MrpParseError('MRP product currency is not an ISO code');
  return currency;
}

function candidateRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(candidateRows);
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return [];
  const fields = canonicalRecord(parsed.data);
  if (readAlias(fields, FIELD_ALIASES.asin) !== undefined) return [parsed.data];

  for (const wrapper of rowWrappers) {
    const nested = fields.get(wrapper)?.value;
    if (nested !== undefined) {
      const rows = candidateRows(nested);
      if (rows.length > 0) return rows;
    }
  }

  const keyedRows: Record<string, unknown>[] = [];
  for (const [key, nested] of Object.entries(parsed.data)) {
    const nestedRecord = recordSchema.safeParse(nested);
    if (/^[A-Z0-9]{10}$/i.test(key) && nestedRecord.success) {
      keyedRows.push({ asin: key, ...nestedRecord.data });
    }
  }
  return keyedRows;
}

function parseRow(value: Record<string, unknown>): MrpProductEconomics {
  const fields = canonicalRecord(value);
  const asinValue = readAlias(fields, FIELD_ALIASES.asin);
  if (typeof asinValue !== 'string' || asinValue.trim() === '') {
    throw new MrpParseError('MRP product row has no ASIN');
  }

  const economics = {
    salePrice: optionalNumber(readAlias(fields, FIELD_ALIASES.salePrice), 'sale_price'),
    cogs: optionalNumber(readAlias(fields, FIELD_ALIASES.cogs), 'cogs'),
    fbaFees: optionalNumber(readAlias(fields, FIELD_ALIASES.fbaFees), 'fba_fees'),
    referralFees: optionalNumber(readAlias(fields, FIELD_ALIASES.referralFees), 'referral_fees'),
    otherFees: optionalNumber(readAlias(fields, FIELD_ALIASES.otherFees), 'other_fees'),
    margin: optionalNumber(readAlias(fields, FIELD_ALIASES.margin), 'margin'),
    ltvRevenue: optionalNumber(readAlias(fields, FIELD_ALIASES.ltvRevenue), 'ltv_revenue'),
    ltvOrders: optionalNumber(readAlias(fields, FIELD_ALIASES.ltvOrders), 'ltv_orders'),
    repeatRate: optionalNumber(readAlias(fields, FIELD_ALIASES.repeatRate), 'repeat_rate'),
  };
  if (Object.values(economics).every((field) => field === null)) {
    throw new MrpParseError(`MRP product ${asinValue.trim()} has no economics fields`);
  }

  const details = Object.fromEntries(
    Object.entries(value).filter(([key]) => !recognizedKeys.has(canonicalKey(key))),
  );

  return {
    asin: asinValue.trim().toUpperCase(),
    capturedOn: optionalDate(readAlias(fields, FIELD_ALIASES.capturedOn)),
    ...economics,
    currency: optionalCurrency(readAlias(fields, FIELD_ALIASES.currency)),
    details,
  };
}

/** Parse common MCP result wrappers into product economics without discarding unknown fields. */
export function parseProductEconomics(value: unknown): MrpProductEconomics[] {
  const rows = candidateRows(value);
  if (rows.length === 0) throw new MrpParseError('MRP tool result contains no product rows');
  return rows.map(parseRow);
}

const TOOL_WEIGHTS: readonly [pattern: RegExp, weight: number][] = [
  [/economics?/, 8],
  [/profits?/, 6],
  [/ltv/, 4],
  [/products?/, 2],
];

/** Pick the strongest deterministic name match; descriptions do not influence selection. */
export function selectEconomicsTool(tools: readonly MrpTool[]): MrpTool {
  const candidates = tools
    .map((tool) => ({
      tool,
      score: TOOL_WEIGHTS.reduce(
        (total, [pattern, weight]) => total + (pattern.test(canonicalKey(tool.name)) ? weight : 0),
        0,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  const selected = candidates[0]?.tool;
  if (!selected) throw new MrpToolNotFoundError('MRP exposed no product economics tool');
  return selected;
}
