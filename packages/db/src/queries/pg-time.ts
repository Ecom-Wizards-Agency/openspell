/**
 * Timestamp marshalling for raw `sql` queries.
 *
 * `createDb` attaches Drizzle to the same postgres.js client it hands back as
 * `sql`, and `drizzle-orm/postgres-js` installs a transparent identity
 * parser *and serializer* on the date OIDs (1082/1083/1114/1184) of the client
 * it is given. Drizzle needs that, because it does its own mapping. The
 * side effect lands on every raw query sharing the client:
 *
 *   - passing a `Date` in throws `The "string" argument must be of type
 *     string ... Received an instance of Date`, because the identity
 *     serializer hands the driver's byte writer an object;
 *   - reading a timestamp back yields the wire `string`, not a `Date`,
 *     so a field typed `Date` silently is not one.
 *
 * A handle built without Drizzle (the web request client) keeps the driver's
 * own date handling, so the two behave differently on the same query. Both
 * directions are therefore marshalled explicitly here rather than left to the
 * driver: `toTimestampParam` for binding, `toDate` for reading. Bound values
 * carry an explicit `::timestamptz` cast at the call site for the same reason
 * `enqueueDueSchedules` does — it pins the type server-side instead of
 * relying on driver inference.
 */

/** Bind a timestamp as an ISO string. Pair with an explicit `::timestamptz`. */
export function toTimestampParam(value: Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const time = value.getTime();
  if (Number.isNaN(time)) throw new Error('Invalid timestamp');
  return value.toISOString();
}

/** Read a timestamp column back as a `Date`, whichever parser was installed. */
export function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp from database: ${value}`);
  return date;
}

/** Nullable form of {@link toDate}. */
export function toDateOrNull(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value);
}
