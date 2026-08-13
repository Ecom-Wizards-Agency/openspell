/**
 * `ApplyRow`: one staged old-to-new change.
 *
 * This contract crosses a language boundary. v1's apply path is an export, not
 * an API write: accepted proposals leave wizard-ads as a rows JSON that the
 * existing Python staged-apply flow (`amazon-agent/tools/amazon-ppc-management/
 * batches.py`) consumes unmodified. That file's documented row shape is
 * snake_case and its validator requires exactly `entity_type`, `entity_id`,
 * `field`, `old`, `new`, with `name` optional and `clicks`/`revenue` optional
 * (its caps-are-ceilings check reads them for the rpc x target-ACOS test).
 *
 * So there are two shapes here and they are not interchangeable:
 *
 *   ApplyRow      camelCase, what TypeScript passes around.
 *   ApplyRowWire  snake_case, byte-compatible with batches.py. Nothing but the
 *                 export bridge should touch it.
 *
 * `serializeApplyRows` is the only sanctioned way to produce the file: it emits
 * the keys in batches.py's documented order with Python's `json.dumps(indent=2)`
 * formatting, so a diff against a Python-written file is empty.
 */
import { z } from 'zod';

/**
 * Entity kinds a staged change can address. `placement` is here and absent from
 * `EntityType` on purpose: a placement modifier is a field of a campaign, not a
 * mirrored entity, but batches.py addresses it as its own row type.
 */
export const ApplyEntityType = z.enum([
  'keyword',
  'target',
  'campaign',
  'ad_group',
  'placement',
]);
export type ApplyEntityType = z.infer<typeof ApplyEntityType>;

/**
 * The lever a batch pulls. Mirrors `KNOWN_LEVERS` in batches.py, which warns
 * (never fails) on an unknown value.
 */
export const ApplyLever = z.enum([
  'waste-cut',
  'bid-down',
  'push',
  'budget',
  'placement',
  'harvest',
  'negative',
  'pause',
  'revert',
  'other',
]);
export type ApplyLever = z.infer<typeof ApplyLever>;

/** Values a staged field can hold. batches.py only does arithmetic on numbers. */
const ApplyValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type ApplyValue = z.infer<typeof ApplyValue>;

/** TypeScript-facing shape. */
export const ApplyRow = z.object({
  entityType: ApplyEntityType,
  entityId: z.string().min(1),
  /** `bid` | `budget` | `state` | `tos_modifier` | ... deliberately open. */
  field: z.string().min(1),
  old: ApplyValue,
  new: ApplyValue,
  name: z.string().optional(),
  /** Optional provenance batches.py reads for its off-formula check. */
  clicks: z.number().optional(),
  revenue: z.number().optional(),
});
export type ApplyRow = z.infer<typeof ApplyRow>;

/** Wire shape. Key order below IS the contract: do not reorder. */
export const ApplyRowWire = z.object({
  entity_type: ApplyEntityType,
  entity_id: z.string().min(1),
  field: z.string().min(1),
  old: ApplyValue,
  new: ApplyValue,
  name: z.string().optional(),
  clicks: z.number().optional(),
  revenue: z.number().optional(),
});
export type ApplyRowWire = z.infer<typeof ApplyRowWire>;

export function toApplyRowWire(row: ApplyRow): ApplyRowWire {
  const wire: ApplyRowWire = {
    entity_type: row.entityType,
    entity_id: row.entityId,
    field: row.field,
    old: row.old,
    new: row.new,
  };
  if (row.name !== undefined) wire.name = row.name;
  if (row.clicks !== undefined) wire.clicks = row.clicks;
  if (row.revenue !== undefined) wire.revenue = row.revenue;
  return wire;
}

export function fromApplyRowWire(wire: ApplyRowWire): ApplyRow {
  const row: ApplyRow = {
    entityType: wire.entity_type,
    entityId: wire.entity_id,
    field: wire.field,
    old: wire.old,
    new: wire.new,
  };
  if (wire.name !== undefined) row.name = wire.name;
  if (wire.clicks !== undefined) row.clicks = wire.clicks;
  if (wire.revenue !== undefined) row.revenue = wire.revenue;
  return row;
}

/**
 * Render rows as the exact file batches.py expects: a JSON list, two-space
 * indent, trailing newline (Python's `json.dumps(..., indent=2)` plus the
 * newline that tool writes).
 */
export function serializeApplyRows(rows: readonly ApplyRow[]): string {
  return `${JSON.stringify(rows.map(toApplyRowWire), null, 2)}\n`;
}
