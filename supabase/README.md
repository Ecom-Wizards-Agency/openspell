# supabase

Owned by **WP-01** (`migrations/`, RLS, partitions, seed).

- `migrations/` numbered SQL migrations. Every tenant table carries `org_id` and RLS.
- `functions/` edge functions. Deliberately not the job executor: the 400s limit
  cannot cover 3-hour report polling or a large GZIP download. That is the Fly worker.
- `seed/` local seed data. Synthetic only, never a client export.

WP-03 hands its `pg_cron` enqueue SQL to WP-01 rather than adding migrations here.
WP-04 hands over the Vault RPC migration the same way. One package owns the schema.
