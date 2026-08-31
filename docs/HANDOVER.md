# OpenSpell continuation handover

Last reconciled: 2026-08-31. This is a rolling handover for the next implementation chat, not a
historical changelog.

## How to use and maintain this file

1. Read `AGENTS.md` completely before taking any action. It is authoritative when this file,
   `docs/STATUS.md`, a work-package brief, or an earlier conversation disagrees.
2. Fetch and reconcile `origin/main`, open pull requests, exact-head CI, the hosted migration
   ledger, and deployed revision before trusting the snapshot below.
3. After completing an item, remove it from the open list and rewrite the verified snapshot. Do
   not append a diary of obsolete states.
4. Keep this file public-safe: no credentials, profile/account/customer names or IDs, doctrine
   thresholds, private repository material, secret-manager locators, or absolute operator paths.
5. When the continuation is complete, delete this handover or reduce it to only the still-open
   gates. A growing archaeological log defeats its purpose.

## Non-negotiable repository boundaries

- The repository is public. Run `pnpm hygiene` before every push.
- `AGENTS.md` still makes v1 read-only. Source code, status prose, or prior authorization that says
  otherwise does not override it. OpenSpell may analyze, propose, preview, and export; it must not
  call an Amazon mutation endpoint until `AGENTS.md` is explicitly changed and a new guarded
  package is approved.
- `packages/shared` is authoritative. Do not introduce duplicate local contracts or widen it as a
  convenience.
- Amazon calls belong in `apps/worker`; `apps/web` never receives Amazon credentials or imports
  `packages/ads-api`.
- Do not apply a hosted migration, seed shared data, change a live service, or move a production
  alias without reconciling the exact target and obtaining the action-specific gate required by
  `AGENTS.md` and `supabase/README.md`.
- Every ingest or list operation must reconcile offered, parsed, refused, promoted, and canonical
  counts. A successful command alone is not evidence that the artifact is correct.

## Verified repository and deployment snapshot

At the time of this handover branch:

- `origin/main`: `44da7ac32e5a0503993e567c41aaccffd5c39b06`.
- Exact-main GitHub Actions run `33321661476` passed the core and Playwright jobs for that revision.
- Tracked production web evidence still identifies
  `5e372c82361776070084e0265fea8c504a0d8781`.
- Tracked MCP evidence still identifies
  `b5c210dca2c28576180223dbe853e61ae7092e73`.
- Therefore current source, deployed web, and deployed MCP are three different revisions. Do not
  describe post-deployment main features as live until a revision-stamped candidate is promoted
  and checked.
- `docs/STATUS.md` was reconciled against the older web revision and is stale for WP-149 onward.
  Use Git, CI, code, the migration ledger, and live health as evidence; then update status prose.

Re-run:

```bash
git fetch origin --prune
git ls-remote origin refs/heads/main
gh run list --branch main --limit 10
gh pr list --state open --json number,title,headRefName,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup
```

## What is already on current main

Recent verified source work includes:

- collapsed Dashboard operating reads, one root render, Grid request-context consolidation,
  closed server timing, Frankfurt function colocation, and bounded Grid response behavior;
- searchable multi-value categorical Grid filters and full N-gram Grid-style filters, grouping,
  columns, counts, and CSV parity;
- Sponsored Brands creative/ad pagination with exact count checks;
- counted Creative lifecycle presentation, an exclusive report-lane contract, a daily Creative
  producer, and a bounded deployment-only pilot gate—all inactive until their hosted and runtime
  gates are satisfied;
- a locked OpenSpell MCP systemd package, but no evidence that this newer source replaced the
  currently tracked MCP runtime;
- default-off password recovery, TOTP, passkey, and provider-login security paths. Provider rollout
  remains separately gated.

These are source outcomes, not blanket claims of live behavior.

## Current pull requests

Reconcile heads and checks again before acting.

### PR #81 — WP-171 weekday schedules

- Head at handover preparation: `1a27dd6882558be7ac40df5393b2288b8820fef3`.
- Replaces ambiguous cadence intervals with profile-local weekday, local-time, and timezone
  controls for optimization groups.
- Local `pnpm check` passed. The core hosted job passed. The earlier Playwright failure was a
  four-gigabyte Next development-server heap exhaustion after the assertions had passed.
- The latest head isolates the optimization-group workflow in a fresh authenticated Next process;
  its exact-head Playwright result was still pending when this file was drafted.
- Do not merge before the exact-head jobs pass and the hosted schema includes
  `20260830180000_optimization_weekday_schedules.sql`. The new web code reads the new columns
  unconditionally.
- PR #40 and its remote branch were closed/deleted because this package supersedes them.

### PR #82 — WP-173 Unified Reporting client

- Head at handover preparation: `d6778c8085a3f1d4c0125df64f5bf23cab5facbf`.
- Adds provider-native, account-scoped create and retrieve methods to `AdsApiClient` while leaving
  Reporting v3 untouched.
- One ordered outcome is required for every submitted item. Missing, repeated, invalid, or
  mismatched indices fail closed.
- Create ambiguity is never replayed blindly; retrieve remains an idempotent analytical read.
  Provider bodies and raw provider messages are not retained.
- Non-null completed-part shapes, downloads, hourly periods, worker scheduling, persistence,
  promotion, live probes, and provider parity are intentionally absent.
- Package typecheck, 260 Ads API tests, focused lint, and `pnpm check` passed locally. Hosted jobs
  were pending when this file was drafted.

### PR #83 — WP-172 Evo report worker cutover

- Head at handover preparation: `c86ea06de0898e8c1fce84f0c394e0d0da265a36`.
- Separates immutable staging from attended activation.
- Activation requires prior Vercel report-claim relinquishment, a retired legacy worker, encrypted
  credential metadata, a full retained artifact, and a bounded read-only database/queue readiness
  check before worker import.
- The Evo health listener is loopback-only. Stage, activate, verify, and rollback share one
  root-owned lock. Recovery is reported only after the prior artifact, current link, retained and
  live units, enabled/active state, and exact health all pass.
- Deployment self-tests, ShellCheck, 39 focused worker tests, and `pnpm check` passed locally.
  Hosted jobs were pending when this file was drafted.
- Nothing was deployed, migrated, started, stopped, enabled, or tested with a live credential.

### Older open work that needs an explicit decision

- PR #17: contextual-negative review/export; conflicting and red.
- PR #24: guarded Sponsored Products write gateway; conflicting and red. It cannot merge while the
  authoritative read-only boundary remains unchanged.
- PR #35: release-artifact checks; conflicting and red. Compare its acceptance criteria with newer
  merged release verification before rebasing or closing it.
- PR #45: campaign-creation contracts stacked on PR #24; red and bound by the same write-policy
  conflict.

Do not keep stale pull requests merely as storage. Preserve useful design in a current brief,
replace or rebase live work, and close branches that are proven superseded.

## Hosted migration gates

The following tracked files were not proven present in the hosted ledger during this reconciliation:

- `20260829140000_feature_job_types.sql`
- `20260829150000_spapi_profile_bindings.sql`
- `20260829160000_sb_video_report_type.sql`
- `20260829160100_sb_video_observed_ingestion.sql`
- `20260830170000_marketing_stream_correctness.sql`
- PR #81 adds `20260830180000_optimization_weekday_schedules.sql`

Before any application:

1. identify the exact hosted project without recording it in Git;
2. compare the hosted ledger and schema to the files;
3. review lock, row-count, index, and RLS impact;
4. state the exact file set and target to the operator;
5. follow the operator-run procedure in `supabase/README.md`;
6. verify the ledger, columns, constraints, indexes, RLS, and pre/post row counts;
7. only then deploy code that assumes the new columns.

WP-171 is schema-before-web. Other packages may be code-first only when their feature flags and
runtime gates are demonstrably inert.

## Feature truth and open activation work

### Creative Performance

The standard schedule is not Sponsored Products-only. It currently includes detailed Sponsored
Products campaign, targeting, search-term, and placement reports plus Sponsored Brands campaign
totals and Sponsored Display campaign totals.

The missing specialized evidence is Sponsored Brands Video ad-level attribution:

```text
SB ad -> creative/version -> Amazon Asset ID -> ad-level report fact
```

The complete source path exists for documented ad and Asset Library pagination, counted lifecycle,
current-snapshot observation, explicit ambiguous/unsupported states, a daily producer, and a
bounded pilot. It is not proven automatically active in production. Activation requires:

- the two SB Video hosted migrations;
- the exclusive Evo report lane;
- all three Creative producer gates and a deployment-only pilot allowlist;
- one authorized read-only profile probe;
- source/ad/creative/asset/report/mapped/upsert count reconciliation;
- live UI verification against authoritative Amazon Asset IDs.

The current empty-state sentence telling the operator to “Run a Creative sync” is misleading when
the automatic producer is enabled. A later web package should derive copy from the actual lifecycle:
inactive gate, queued, report pending, mapping pending, unsupported, blocked, or current.

### SQP and Query Intelligence

The pure SP-API client, weekly planning, taxonomy, vocabulary approval, resumable checkpointing,
spend-conserving joins, and review proposals exist. Live weekly execution still needs the hosted
feature/binding migrations, deployment-owned LWA configuration, tenant bindings, and one counted
read-only report parity check. Do not substitute Ads API search-term data for authoritative Brand
Analytics SQP.

### Dayparting

The raw/revision ledger, normalized hourly facts, DST-local view, settling states, confidence
shrinkage, schedule proposal, and export surfaces exist. Automatic execution remains out of scope.
Live data still needs the hosted correctness migration and an AWS SQS/Marketing Stream subscription
with message, revision, normalization, duplicate, and acknowledgement counts. Advertising API
daily reports are not authoritative hourly Marketing Stream data.

### Unified Reporting

PR #82 is only a strict transport boundary. The next package should add a worker-owned, feature-
gated dual-run coordinator that retains Reporting v3 as promotion authority, stores each provider's
outcome separately, and never erases a v3 success because Unified Reporting was ambiguous. Ground
completed parts and any hourly availability with primary evidence before adding downloads or
history bootstrap.

### Optimizer and Time Machine

Stateful recommendation evidence, synchronization observation, hold/continue/revert decisions,
conflict-safe inverse exports, bounded campaign windows, and persistent groups exist. WP-171 makes
schedule intent operator-readable. A complete live reversion remains unproven until an eligible
export batch exists. No live Amazon mutation is permitted under the current `AGENTS.md`.

## Known UX and performance follow-ups

1. When every navigation group is expanded, the active marker and utility footer collide because
   the entire sidebar owns scrolling while the footer is also pushed with auto margin. Fix in a
   fresh serialized web package after WP-171: keep brand/footer non-shrinking, give only the main
   navigation `min-height: 0` plus vertical overflow, simplify the active marker, and add a browser
   regression at the affected viewport with every group open.
2. Replace the Creative empty-state command copy with lifecycle-aware automatic-sync copy.
3. Production Grid and Time Machine first loads remain above the intended targets. Use the closed
   `Server-Timing` spans to choose the next bottleneck; do not hide the delay with optimistic copy
   or weaken complete-row/count behavior.
4. Re-run a complete authenticated OpenSpell click-through after deploying a current revision.
   Cover loaded, empty, partial, stale, settling, error, and permission states; both themes;
   keyboard operation; exact exports; and realistic row counts.
5. Repeat the equivalent read-only workflows in AdLabs and SYNQ, then classify differences as
   correctness, missing capability, interaction friction, unnecessary complexity, hierarchy, or
   polish. Do not modify competitor state or copy unsafe push behavior.
6. Reconcile the large current-state drift in `docs/STATUS.md` only after live deployment and QA.

## Recommended continuation order

1. Wait for exact-head CI on PRs #81, #82, and #83. Diagnose artifacts, not check labels.
2. Merge #82 and #83 only when green. Rebase/update the second PR after the first merge if the base
   changes, then require fresh exact-head evidence.
3. Keep #81 open until both CI and its hosted migration gate are closed.
4. Update this file from the resulting `origin/main`; remove completed PR entries.
5. Apply only the exact authorized hosted migrations through the documented operator procedure and
   record sanitized count/RLS evidence.
6. Deploy a revision-stamped web candidate from clean main, complete authenticated QA, and promote
   only after the candidate revision and route artifacts match.
7. Stage the Evo report worker from that exact clean main revision. Transfer Vercel report claims
   first, prove the legacy unit retired, then perform the attended activation and exact health/queue
   checks. Never allow overlapping consumers.
8. Activate the bounded Creative pilot and reconcile authoritative Asset IDs and every count.
9. Add the Unified Reporting worker dual-run without changing promotion authority.
10. Implement the sidebar and Creative-copy fixes, then repeat deployed OpenSpell and competitor QA.
11. Reconcile status, deployed revisions, migrations, open PRs, branches, and worktrees again.

If an external gate blocks one lane, continue with the next independent source-only package. Do
not reinterpret waiting as authorization to mutate production.

## High versus Extra High reasoning

Use **High** for bounded work whose failure stays local and is easy to detect:

- one-package pure clients, parsers, fixtures, and count reconciliation;
- focused UI components, copy, accessibility, styling, and browser regressions;
- read-only evidence gathering, route timing, Git/CI reconciliation, and documentation;
- deterministic refactors with established contracts and strong existing tests;
- synthetic worker tests that do not change queue ownership or live state.

Use **Extra High** for decisions where a locally plausible change can corrupt data, cross a security
boundary, create duplicate work, or make rollback unreliable:

- migrations, RLS, retention, promotion watermarks, stale-row replacement, and production count
  reconciliation;
- authentication, MFA/passkeys, credentials, tenant fencing, token scopes, and MCP authorization;
- Vercel/Evo queue ownership transfer, systemd activation, rollback, and deployed revision proof;
- optimizer observation windows, anti-compounding, Time Machine inversion/conflict logic, and any
  future Amazon mutation design;
- cross-package shared contracts, release integration, competing implementation synthesis, and
  final go/no-go decisions.

Practical delegation rule:

- Keep the coordinating agent on Extra High for architecture, integration, production gates, and
  final review.
- Give a High subagent one concrete, non-overlapping package or evidence question with explicit
  files and acceptance checks.
- Use an Extra High subagent for an independent risk review of migrations, auth, queue handoff,
  rollback, or irreversible/external actions.
- Escalate High work to Extra High as soon as it changes a shared contract, tenant data, queue
  ownership, authorization, production state, or cross-package lifecycle.

High is enough for most implementation. Extra High should be spent on the boundaries where being
subtly wrong is expensive, not on routine code volume.

## Verification and release discipline

For every package:

```bash
pnpm check
git diff --check
git status --short
```

Run hygiene after new files are staged (or through a temporary index). The linter intentionally
reads Git's tracked-file list, so a clean result before staging does not inspect an untracked file.

Also run the focused package tests, migration/RLS tests where applicable, count assertions, worker
retry/throttle/idempotency/failure tests, critical Playwright workflows, and an explicit check that
no Amazon mutation endpoint was invoked. A merge requires the exact pushed head to pass hosted CI.

A deployment is complete only when the live health revision, distinctive route artifact, data
counts, and operator workflow match the intended commit. “Vercel ready,” “service active,” or a
green command by itself is insufficient.

## Safe branch and worktree cleanup

After a branch is merged or proven superseded:

1. verify its worktree is clean;
2. verify its commits are reachable from main or preserved by the closed pull request;
3. remove that exact worktree;
4. delete the exact local branch;
5. delete the exact remote branch only when it is no longer active;
6. fetch with prune and re-list worktrees/refs.

Never use a broad branch glob or delete a dirty worktree. Preserve the original operator workspace
and any unrelated changes.
