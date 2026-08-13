/**
 * Layered merge with provenance.
 *
 * Merge order, lowest to highest: neutral defaults, goal lens, tenant document,
 * profile override. Later layers win leaf by leaf, so a tenant that sets one
 * cap does not lose the rest of the document.
 *
 * Every resolved leaf records which layer supplied it. That is the same
 * discipline the recommendation `inputs` follow: when an operator asks why a
 * campaign is being optimized to a particular target, "because the profile
 * override says so, and here is the layer it came from" is an answer, and
 * "because the config said so" is not.
 */

export type Layer = 'defaults' | 'goal_lens' | 'tenant' | 'profile';

export const LAYER_ORDER: Layer[] = ['defaults', 'goal_lens', 'tenant', 'profile'];

/** Path (dot-joined) to the layer that supplied the value living there. */
export type Provenance = Record<string, Layer>;

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `source` onto `target`.
 *
 * Arrays replace wholesale rather than concatenating: a tenant that states a
 * cut order means that order, not the default order with theirs appended.
 * `undefined` never overwrites; `null` does, because an explicit null is a
 * statement ("no monthly budget") and an absent key is not.
 */
export function deepMergeInto(
  target: Plain,
  source: Plain,
  layer: Layer,
  provenance: Provenance,
  prefix = '',
): Plain {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      deepMergeInto(existing, value, layer, provenance, path);
      continue;
    }
    target[key] = isPlainObject(value) ? deepMergeInto({}, value, layer, provenance, path) : value;
    provenance[path] = layer;
  }
  return target;
}

export interface MergeResult<T> {
  value: T;
  provenance: Provenance;
}

/** Merge an ordered list of `[layer, document]` pairs, lowest priority first. */
export function mergeLayers<T extends Plain>(layers: Array<[Layer, Plain | null | undefined]>): MergeResult<T> {
  const out: Plain = {};
  const provenance: Provenance = {};
  for (const [layer, document] of layers) {
    if (!document) continue;
    deepMergeInto(out, document, layer, provenance);
  }
  return { value: out as T, provenance };
}
