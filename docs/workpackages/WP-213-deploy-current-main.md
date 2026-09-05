# WP-213 — Deploy current main: web, MCP, worker

Owner: implementer, with the operator present for each deployment step.

Depends on: WP-207 postflight at 46 ledger versions; WP-216 merged; WP-208 merged if ready.
`docs/HANDOVER.md` and `docs/STATUS.md` are edited here only after WP-207 has finished with
them.

## Objective

End the deployment drift: production web at the current main revision through a verified
candidate, the MCP service on the same revision on the Evo host, and the legacy integration
worker updated to the same revision. Write the web deployment runbook that does not exist.

## Owned files

- `docs/deploy/web-vercel.md` (new runbook);
- `docs/HANDOVER.md` "Verified repository and deployment snapshot";
- `docs/STATUS.md` "Dated live and deployed evidence" and "Release gates";
- this brief.

## Read first

1. `docs/deploy/mcp-evo.md`, `docs/deploy/install-mcp-evo-systemd.sh`,
   `verify-mcp-evo-systemd.sh`, `rollback-mcp-evo-systemd.sh`.
2. `docs/deploy/always-on-worker.md`.
3. `apps/web/package.json` script `verify:release-candidate` and
   `apps/web/src/release/candidate-artifacts.ts`.
4. `docs/STATUS.md` entries describing earlier candidate deployments and promotions.

## Required behavior

### Web

1. Runbook: clean worktree at the exact main revision; `vercel build` and `vercel deploy
   --prebuilt` to an immutable candidate URL with `OPENSPELL_WEB_REVISION` set to that revision;
   `pnpm --filter @wizard-ads/web verify:release-candidate` against the candidate; authenticated
   click-through of all 35 pages in both themes covering loaded, empty, error and permission
   states; promote; confirm `/api/healthz` reports the revision; rollback is promoting the
   previous deployment.
2. Environment: keep `OPENSPELL_EVO_REPORT_LANE_READY` and the creative variables exactly as
   WP-210 left them; keep `OPENSPELL_RECOMMENDATION_LANE_READY` unset so WP-216 legacy mode
   applies; confirm the Vercel plan allows the cron route's 300-second `maxDuration`.
3. After promotion, confirm one cron tick succeeds and claimed jobs finish, which proves finding
   F1 is closed in production.

### MCP

4. Follow `docs/deploy/mcp-evo.md` in order: stage the two encrypted credentials, approve the
   cloudflared checksum, test, install, create the route-exclusivity record, stop the legacy
   service, activate, verify, and repeat the two-client discovery check with all 11 tools and an
   audit-log read. The MCP references no pending migration.

### Worker

5. Update the legacy integration worker on Evo to the deployed main revision with its existing
   role and job types; the legacy claim path works once `20260901040000` is hosted. Verify its
   health endpoint, observe two claim cycles, and record `NRestarts=0`.
6. Do not stage or activate the fenced report worker or the recommendation worker; both remain
   later packages. Do not retire `wizard-ads-worker.service`.

### Freeze

7. Once web, Vercel cron and the worker are on one revision and WP-216 is live, record in
   `docs/HANDOVER.md` that the optimizer edit and job-creation freeze is lifted.

## Authorization

Each step in each section is a separate operator action stated in the current task: Vercel
candidate deploy, promotion, MCP install and activation, worker update. Nothing here authorizes
a migration, a provider write or a queue-ownership transfer.

## Acceptance

1. `/api/healthz` on production reports the main revision; the candidate verifier passed.
2. MCP health reports the same revision; discovery shows 11 tools; audit rows appear.
3. Worker health reports the revision; two clean claim cycles; `NRestarts=0`.
4. The click-through is recorded per page with no 5xx and no Amazon write.
5. `docs/HANDOVER.md` and `docs/STATUS.md` reflect the new snapshot; `pnpm hygiene` passes.
