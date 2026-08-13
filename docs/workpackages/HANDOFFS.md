# Kickoff handoffs — paste-ready prompts per work package

Each block below is the complete prompt for a fresh implementer session. Paste it into Codex
(or the manager launches it as a subagent). Everything substantive lives in the briefs; the
handoff adds only session-specific state.

**Gate: WP-02/03/04 start only after WP-00 is merged to `main`** (the `packages/shared`
contracts must exist). If `packages/shared/src` is missing or empty, stop and report — do not
invent contracts.

---

## WP-02 — Amazon Ads API client (Codex)

```
You are an implementation agent on the wizard-ads project (an in-house Amazon Ads
management tool; a manager agent reviews your work). Work in ~/os/wizard-ads.

Read first, in order:
1. docs/workpackages/README.md  (program rules — package ownership, hygiene, no-cross-edits)
2. docs/workpackages/WP-02-ads-api-client.md  (your brief; its "Read first" files are the spec)

Then implement WP-02 exactly as briefed, on branch wp-02-ads-api created from latest main.
Session notes:
- You own packages/ads-api ONLY. Do not touch other packages/apps. Contracts come from
  packages/shared; if a needed type is missing, stop and report — never add it yourself.
- The live smoke script reads _local/ads-api.config.json (operator places it; you commit only
  ads-api.config.TEMPLATE.json). Do not run the live smoke unattended — implement it, then
  list the exact command for the operator in your report.
- Verify with: pnpm install && pnpm check, plus your package's vitest suite.
When finished, report per the brief's acceptance checks: what you ran, what proved each check,
deviations with reasons, blockers at the top.
```

---

## WP-03 — Sync worker + queue + scheduler (Codex)

```
You are an implementation agent on the wizard-ads project (an in-house Amazon Ads
management tool; a manager agent reviews your work). Work in ~/os/wizard-ads.

Read first, in order:
1. docs/workpackages/README.md  (program rules — package ownership, hygiene, no-cross-edits)
2. docs/workpackages/WP-03-worker-queue.md  (your brief)
3. docs/PLAN.md section "Sync architecture"

Then implement WP-03 exactly as briefed, on branch wp-03-worker created from latest main.
Session notes:
- You own apps/worker ONLY. DB access goes through packages/db.
- Dependency state: WP-01 (db schema) and WP-02 (ads-api) may be in flight. Code against
  their contracts in packages/shared; where you need packages/db functions
  (claim_sync_jobs, enqueue_due_schedules) or the ads-api client before they're merged,
  build against a typed mock/interface and mark each integration point with a
  `// INTEGRATE(WP-01)` / `// INTEGRATE(WP-02)` comment, listed in your report.
- Integration tests run against a local Postgres (supabase start or docker) with your own
  minimal test tables where WP-01 tables aren't merged yet — clearly separated so the switch
  to real migrations is mechanical.
- Any pg_cron/SQL you need lands as a proposal file handed to WP-01 (docs/handoffs-to-wp01.md),
  not as your own migration.
- Verify with: pnpm install && pnpm check, plus your package's vitest suite.
When finished, report per the brief's acceptance checks: what you ran, what proved each check,
INTEGRATE points outstanding, deviations with reasons, blockers at the top.
```

---

## WP-04 — Web auth + orgs + LWA OAuth + connections UI (Codex)

```
You are an implementation agent on the wizard-ads project (an in-house Amazon Ads
management tool; a manager agent reviews your work). Work in ~/os/wizard-ads.

Read first, in order:
1. docs/workpackages/README.md  (program rules — package ownership, hygiene, no-cross-edits)
2. docs/workpackages/WP-04-web-auth-oauth.md  (your brief; the callback-worker file listed
   there is the state-signing pattern to mirror)

Then implement WP-04 exactly as briefed, on branch wp-04-web-auth created from latest main.
Session notes:
- You own apps/web auth/oauth/settings/sync-status routes ONLY. No dashboard/grid work.
- Dependency state: WP-01 (db schema incl. Vault RPCs) may be in flight. Code against the
  packages/shared contracts; mock the Vault RPC + tables behind a thin interface and mark
  integration points `// INTEGRATE(WP-01)`, listed in your report. Any migration you need
  (e.g. the Vault RPC) is a proposal file in docs/handoffs-to-wp01.md, not your own migration.
- All tests run against mocked LWA (no real Amazon calls). The real redirect URI is NOT yet
  registered on the LWA app — live OAuth testing is a later operator step; say so in your
  report rather than attempting it.
- Secrets only via server env (.env.local, gitignored); commit .env.TEMPLATE with names only.
- Verify with: pnpm install && pnpm check, your vitest suite, and the Playwright flow with
  mocked LWA.
When finished, report per the brief's acceptance checks: what you ran, what proved each check,
INTEGRATE points outstanding, deviations with reasons, blockers at the top.
```
