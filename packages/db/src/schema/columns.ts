/**
 * Column helpers shared by every table file.
 *
 * Two of them exist because of how Postgres types arrive in JavaScript.
 * `numeric` comes back as a string (correctly: it is arbitrary precision), and
 * `bigint` comes back as a string too. Both are mapped to `number` here, once,
 * rather than in forty call sites: every value in this schema that uses them is
 * money under 1e12 or a count under 2^53, and the contracts in
 * `@wizard-ads/shared` type them as numbers.
 *
 * If a column ever needs true arbitrary precision, it declares `numeric()`
 * itself and the mapping stays honest.
 */
import { bigint, numeric, timestamp } from 'drizzle-orm/pg-core';

/** Money and ratios. Postgres numeric, JavaScript number. */
export const money = (name: string, precision = 14, scale = 4) =>
  numeric(name, { precision, scale, mode: 'number' });

/** Counts. Postgres bigint, JavaScript number. */
export const count = (name: string) => bigint(name, { mode: 'number' });

/** Every timestamp in this schema is timestamptz. Local time is not a thing here. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
