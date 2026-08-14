/**
 * Binding a jsonb parameter.
 *
 * The value is serialised here and cast in the statement (`$n::jsonb`) rather
 * than handed to postgres.js as a typed json parameter. That is not a style
 * preference: the driver's own `sql.json` helper tags the parameter as jsonb
 * and then fails to find a serializer for that oid on a non-prepared
 * connection, and this schema runs with `prepare: false` because Supabase's
 * transaction-mode pooler does not support prepared statements. A string plus a
 * cast works on every connection mode there is.
 */

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}
