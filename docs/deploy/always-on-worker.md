# Always-on integration worker

Run the four integration queues on a Linux host that stays online. Amazon entity
and report jobs remain on the Vercel cron runtime; this process does not need any
`ADS_*` or LWA environment variables when its allowlist contains only integration
jobs.

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

## Environment file

Create `/etc/wizard-ads/worker.env`, owned by root and readable by the service user
only (`chmod 600`). Never place this file in the repository.

```dotenv
DATABASE_URL=<your-service-role-database-url>
WORKER_ID=integration-linux-1
WORKER_JOB_TYPES=keepa.sync,rank.sync,economics.sync,sqp.categorize
WORKER_MAX_CONCURRENT_JOBS=4
PORT=3000
```

`DATABASE_URL` must authenticate as the service role because queue claims and future
integration-secret reads are service-role-only. Use the direct or pooler connection
string appropriate for a long-running process. Do not put a browser Supabase key in
this file; the worker connects to Postgres.

## systemd unit

Install this as `/etc/systemd/system/wizard-ads-integration-worker.service`. Replace
`wizard-ads` with the unprivileged account that owns the checkout.

```ini
[Unit]
Description=wizard-ads integration queue worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wizard-ads
Group=wizard-ads
WorkingDirectory=/opt/wizard-ads
EnvironmentFile=/etc/wizard-ads/worker.env
ExecStart=/usr/bin/env pnpm --filter @wizard-ads/worker start
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Load and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wizard-ads-integration-worker
sudo systemctl status wizard-ads-integration-worker
journalctl -u wizard-ads-integration-worker -f
```

The health endpoint listens on the configured `PORT`; keep it firewalled or expose it
only through the host's monitoring network.

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

Stop the service, check out the approved commit, reinstall with the frozen lockfile,
and start it again. `SIGTERM` gives the worker up to 25 seconds to finish in-flight
jobs, then releases remaining claims to `queued`. To roll back, repeat with the prior
approved commit; do not roll back a database migration by editing production data.
