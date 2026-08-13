# supabase

Owned by **WP-01**. The SQL here is the schema; `packages/db` mirrors it.

- `migrations/` numbered SQL migrations, applied in filename order. Every tenant
  table carries `org_id` and RLS.
- `functions/` edge functions. Deliberately not the job executor: the 400s limit
  cannot cover 3-hour report polling or a large GZIP download. That is the Fly worker.
- `seed/` operator-run seeders (TypeScript, not SQL: one validates a document
  against a contract, the other generates facts).
- `tests/` fixtures for the database suite. Not migrations, never applied to a project.
- `config.toml` local stack configuration, minimal on purpose.

WP-03 hands its `pg_cron` enqueue SQL to WP-01 rather than adding migrations here.
WP-04 hands over the Vault RPC migration the same way. One package owns the schema.

## Working locally

```bash
supabase start          # first time, and after a reboot
supabase db reset       # drop, recreate, apply every migration in order
pnpm --filter @wizard-ads/db test    # the database suite, against that stack
```

The test suite talks to `postgres://postgres:postgres@127.0.0.1:54322/postgres`
by default, which is what `supabase start` publishes, so no configuration is
needed in the normal case. Point it elsewhere with `WIZARD_ADS_TEST_DATABASE_URL`
(or `DATABASE_URL`), and note that `pnpm test` runs tasks through Turborepo,
which filters unknown environment variables: to use a non-default database, run
vitest directly in `packages/db` rather than through the root script.

Every suite builds its own throwaway database, applies the real migration files,
and drops it afterwards. **Nothing runs against a shared database**, and no test
touches the hosted project.

### Without a local Supabase

The suite also runs against a plain Postgres 15+. `tests/supabase-platform-shim.sql`
creates the smallest believable version of what the platform supplies (the
`anon` / `authenticated` / `service_role` roles, `auth.uid()`, Vault, pg_cron),
each statement guarded so applying it to a real Supabase changes nothing. That
is how the same migration files are proven in both places.

When no database is reachable at all, the database suites skip rather than fail,
so CI stays honest on a machine with no Postgres.

## Seeding

```bash
# Doctrine, from a gitignored local file. Operator-run, never automated.
DATABASE_URL=... pnpm --filter @wizard-ads/db seed:strategy -- --org <slug>

# Synthetic development data: one org, four profiles, 60 days of facts.
DATABASE_URL=... pnpm --filter @wizard-ads/db seed:dev
```

`seed:strategy` reads `_local/strategy.<slug>.json`, which is gitignored. Only
`_local/strategy.TEMPLATE.json` is ever committed: threshold values are the
agency's method and this repository is public. The seeder refuses a document
that still contains template placeholders, and validates the rest against
`TenantStrategy` in `packages/shared` before writing.

`seed:dev` refuses to run against anything but localhost unless forced.

## Applying to the hosted project

`supabase db push` after review, by the operator, never by an implementer agent.
