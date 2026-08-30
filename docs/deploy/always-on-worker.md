# Always-on integration worker

This page describes the legacy integration-only worker. It does not authorize the
exclusive Amazon report lane. The Evo report worker has its own immutable systemd
package and runbook in [evo-report-worker.md](./evo-report-worker.md).

Run the four integration queues on a Linux host that stays online. Amazon entity
and report jobs remain on the Vercel cron runtime; this process does not need any
Ads application variables when its allowlist contains only integration jobs.

## Install

The host needs Node 22 or newer, Corepack/pnpm, Git, and network access to the
Supabase Postgres endpoint. Put a clean checkout at `/opt/wizard-ads`, check out the
approved release commit, and install the locked workspace dependencies:

```bash
cd /opt/wizard-ads
corepack enable
pnpm install --frozen-lockfile
```

This repository consumes workspace TypeScript source directly, so the supported
systemd command is the package's pnpm start script. If a later deployment produces
compiled output, `node apps/worker/dist/main.js` can replace it without changing the
environment or claim policy below.

## Credential boundary

The former plaintext environment-file recipe is retired. Do not create or preserve
`worker.env`. Any refreshed integration deployment must use TPM-encrypted systemd
credentials and a versioned, strict public configuration, following the custody and
immutable-release pattern in [evo-report-worker.md](./evo-report-worker.md).

The database credential must authenticate as the service role because queue claims
and integration-secret reads are service-role-only. Use the direct or pooler connection
string appropriate for a long-running process. A browser Supabase key is not a worker
database credential.

## systemd refresh required

The mutable-checkout unit and its `EnvironmentFile=` boundary are no longer approved.
Keep an existing legacy integration service unchanged until a dedicated migration
package replaces it; do not use this retired recipe for a new host or reinstall.

The health endpoint must stay firewalled or be exposed only through the host's
monitoring network.

## Coexistence with Vercel cron

Both runtimes use the same atomic `FOR UPDATE SKIP LOCKED` claim operation, so a job
cannot be handed to both. Their allowlists also divide responsibility before a claim:

- the always-on service claims `keepa.sync`, `rank.sync`, `economics.sync`, and
  `sqp.categorize`;
- Vercel cron explicitly claims `entity.sync`, `report.request`, `report.poll`,
  `report.fetch`, and `recommendations.run`.

This keeps Amazon concurrency at the cron runtime's existing limit. A missing
integration handler dead-letters its job with `"<job type> handler not deployed in
this runtime"`; deploy WP-42/43/44/46 handler wiring before enabling their active
connections.

Schedule reconciliation runs in both runtimes and is idempotent. It creates schedules
only from active integration connections, selects the first sync-enabled profile per
org/country unless `config.profile_id` designates one, and disables the provider's
schedule after the last applicable connection is no longer active. Atomic schedule
upserts and queue dedupe make concurrent passes safe.

## Updating and rollback

Do not update this legacy service by mutating its checkout. Migrate it through a
separately reviewed immutable release package. `SIGTERM` gives the worker up to 25
seconds to finish in-flight jobs, then releases remaining claims to `queued`. A
worker rollback never rolls back a database migration by editing production data.
