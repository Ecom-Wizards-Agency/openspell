# OpenSpell continuation handover

Last reconciled: 2026-09-01. This is a rolling handover for the next implementation chat, not a
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
- Amazon writes are allowed only through the guarded contract in `AGENTS.md`: worker-only
  execution, explicit environment and profile enablement, immutable preview, unambiguous approval,
  idempotent conflict checks, exact counts, audit/resynchronization, and fail-closed cadence gates.
  A read credential, sync, proposal, or schedule never implies write permission.
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

At the time this handover was reconciled:

- `origin/main` is `6d182e6e7a1e51958da2a347044e71fd365d0e41`. WP-182 merged through PR
  #93 at `5d36457f7f4c414fdc58f62130b69c0407361db2`; exact-head run `33445328649`
  passed both jobs on attempt 2 after one unrelated invitation redirect timing failure. Exact-main
  run `33447338899` then exposed a pre-existing Next dev HMR `networkidle` test defect after the
  required redirect artifacts had rendered. PR #94 removed only that redundant wait; its exact-head
  run `33449128504` and exact-main run `33449983074` passed both jobs on their first attempts.
- The WP-182 closeout run then crossed the September boundary and exposed a fresh-database fixture
  gap for prior-month facts. Test-only PR #96 made the tenant fixture open its current and preceding
  calendar months. It merged at `6d182e6e7a1e51958da2a347044e71fd365d0e41`; exact-head run
  `33454770170` and exact-main run `33455623011` passed both jobs on their first attempts.
- Vercel reports the latest production-target deployment READY at
  `44da7ac32e5a0503993e567c41aaccffd5c39b06`, 21 commits behind current main. A direct anonymous
  `/api/healthz` request now redirects to Vercel SSO, so web health was not independently rechecked.
- Production MCP health identifies `b5c210dca2c28576180223dbe853e61ae7092e73`, 161 commits behind
  current main, and still returns the legacy `wizard-ads` service shape.
- The new Evo report-worker unit is not installed and its loopback health is unavailable. The
  legacy integration worker is active but exposes no revision stamp. Its recent journal has
  recurring Keepa `/product` failures, so exact source revision and integration health are both
  unproven.
- Current source, deployed web, deployed MCP, and the active worker are not one proven release. Do
  not describe post-deployment main features as live until a revision-stamped candidate is promoted
  and checked.
- `docs/STATUS.md` now records WP-179 through WP-183, but the implementation-wave table remains
  incomplete between WP-149 and WP-178. Use Git, CI, code, the migration ledger, and live health as
  evidence; then update status prose.

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
- a hardened, staged Evo report-worker cutover package with loopback health, bounded readiness,
  one deployment lock, exact verification, and fail-closed recovery. It has not been activated;
- strict provider-native Unified Reporting create/retrieve methods with exact indexed accounting,
  ambiguity-safe create behavior, idempotent retrieval, and no download or promotion claim;
- a default-off Unified Reporting dual-run sidecar for `spCampaigns`, with explicit advertiser
  bindings, a durable one-send create fence, bounded retrieval, separate provider outcomes, and
  Reporting v3 as the sole fact and promotion authority. PR #91 and this reconciliation performed
  no hosted migration, binding, activation, provider call, download, fact write, or history
  bootstrap; hosted migration and binding state remain unverified;
- inactive campaign-creation plans, approvals, write-ahead evidence, closed accounting, and exact
  observation-gated dependencies; no creation job is active and no provider runtime exists;
- inert, guarded Sponsored Products update-plan contracts under the explicit
  `@wizard-ads/shared/sp-writes` subpath, with exact fingerprints, bounded provider accounting,
  complete placement-state evidence, and no job, migration, provider call, or worker activation;
- an inert Sponsored Products provider adapter under the explicit
  `@wizard-ads/ads-api/sp-write-adapter` subpath, with complete observation, marketplace decimal
  policy, one-attempt mutation transport, strict indexed-result closure, cancellation-safe
  credentials, and no worker consumer or live provider activation;
- a complete, bounded contextual-negative decision queue with explicit accept, dismiss and reopen,
  review-preserving refresh, and immutable exact-byte JSON/CSV evidence export. It remains an
  operator review/export workflow: it does not enqueue or apply an Amazon action, and its hosted
  migration and dependent web deployment were not performed by WP-182;
- default-off password recovery, TOTP, passkey, and provider-login security paths. Provider rollout
  remains separately gated.

These are source outcomes, not blanket claims of live behavior.

## Current pull requests

Reconcile heads and checks again before acting.

### PR #81 — WP-171 weekday schedules

- Head at handover preparation: `2dccb6109332cd598747a45bf2e918d5f52853e6`; it is conflicting,
  18 commits behind current main, and six commits ahead of its merge base.
- Replaces ambiguous cadence intervals with profile-local weekday, local-time, and timezone
  controls for optimization groups.
- Local `pnpm check` passed. Its two displayed checks are green, but GitHub tested a synthetic merge
  against older main; they are not proof for the raw head on current main. Update or rebase after
  the migration gate closes, then require both jobs on the resulting exact integration SHA.
- The latest head isolates the optimization-group workflow in a fresh authenticated Next process.
- Do not merge before the final current-main integration jobs pass and the hosted schema includes
  `20260830180000_optimization_weekday_schedules.sql`. The new web code reads the new columns
  unconditionally.
- PR #40 and its remote branch were closed/deleted because this package supersedes them.

### Older open work that needs an explicit decision

- PR #24: guarded Sponsored Products write gateway; 118 commits behind, conflicting, and failing.
  WP-179 and WP-180 supersede its shared-contract and provider-adapter portions. Preserve only its
  still-distinct persistence and worker ideas through current, separately reviewed slices, then
  close the old PR.
- PR #35: release-artifact checks; 118 commits behind, conflicting, failing, and partly superseded
  by the merged release transport. Port only the still-distinct SVG, Grid context/date, brand, and
  recommendation artifact assertions into the current verifier, then close it.
Do not keep stale pull requests merely as storage. Preserve useful design in a current brief,
replace or rebase live work, and close branches that are proven superseded.

PR #17 and its remote branch were closed/deleted after PR #93 preserved the distinct
contextual-negative workflow on current main with stricter capacity, audit, tenant, and immutable
artifact guarantees.

## Hosted migration gates

The following tracked files were not proven present in the hosted ledger during this reconciliation:

- `20260829140000_feature_job_types.sql`
- `20260829150000_spapi_profile_bindings.sql`
- `20260829160000_sb_video_report_type.sql`
- `20260829160100_sb_video_observed_ingestion.sql`
- `20260830170000_marketing_stream_correctness.sql`
- PR #81 adds `20260830180000_optimization_weekday_schedules.sql`
- `20260831100000_unified_reporting_dual_run.sql`
- `20260901000000_contextual_negative_review_exports.sql`

This machine has no linked Supabase project or injected read-only database credential. The Vercel
session confirms that database variables exist without exposing their values. The expected
1Password account is configured, but this shell is not signed in and has no injected service-account
token. Hosted truth for all eight files therefore remains unproven; no database connection,
migration, seed, or schema mutation was attempted.

Before any application:

1. identify the exact hosted project without recording it in Git;
2. compare the hosted ledger and schema to the files;
3. review lock, row-count, index, and RLS impact;
4. state the exact file set and target to the operator;
5. follow the operator-run procedure in `supabase/README.md`;
6. verify the ledger, columns, constraints, indexes, RLS, and pre/post row counts;
7. only then deploy code that assumes the new columns.

WP-171 and WP-182 are schema-before-web. Do not deploy a web revision that reads either migration's
new storage until that exact schema is verified ready. Other packages may be code-first only when
their feature flags and runtime gates are demonstrably inert.

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

PR #86 replaces the misleading manual-sync sentence with lifecycle-aware automatic-sync copy. It is
source-only until final integration CI, merge, deployment, and live verification complete.

### SQP and Query Intelligence

The pure SP-API client, weekly planning, taxonomy, vocabulary approval, resumable checkpointing,
spend-conserving joins, review proposals, complete bounded decision queue, and immutable evidence
exports exist in source. Live weekly execution still needs the hosted feature/binding migrations,
deployment-owned LWA configuration, tenant bindings, and one counted read-only report parity check.
The review/export UI additionally needs its exact hosted migration and a revision-matched web
deployment. Do not substitute Ads API search-term data for authoritative Brand Analytics SQP, and
do not describe exported negatives as applied to Amazon.

### Dayparting

The raw/revision ledger, normalized hourly facts, DST-local view, settling states, confidence
shrinkage, schedule proposal, and export surfaces exist. Automatic execution remains out of scope.
Live data still needs the hosted correctness migration and an AWS SQS/Marketing Stream subscription
with message, revision, normalization, duplicate, and acknowledgement counts. Advertising API
daily reports are not authoritative hourly Marketing Stream data.

### Unified Reporting

WP-181 adds the worker-owned, default-off dual-run coordinator on top of PR #82's strict transport.
It accepts only `spCampaigns`, binds the advertiser explicitly, stores each provider outcome
separately, and leaves Reporting v3 as the sole fact and promotion authority even when Unified
Reporting is ambiguous. Proof of the hosted migration and tenant bindings, plus deployment and
activation, remain open. Activation separately requires a bounded deployment allowlist, the exact
five-type Evo health contract, and authorization for the exact read-only provider probe. Ground
provider downloads, fact equivalence, history, and any hourly availability with primary evidence
before extending this boundary.

### Optimizer and Time Machine

Stateful recommendation evidence, synchronization observation, hold/continue/revert decisions,
conflict-safe inverse exports, bounded campaign windows, and persistent groups exist. WP-171 makes
schedule intent operator-readable. A complete live reversion remains unproven until an eligible
export batch exists. Any Amazon application or reversion must satisfy the guarded write contract and
an exact current-task authorization.

## Known UX and performance follow-ups

1. When every navigation group is expanded, the active marker and utility footer collide because
   the entire sidebar owns scrolling while the footer is also pushed with auto margin. Fix in a
   fresh serialized web package after WP-171: keep brand/footer non-shrinking, give only the main
   navigation `min-height: 0` plus vertical overflow, simplify the active marker, and add a browser
   regression at the affected viewport with every group open.
2. Production Grid and Time Machine first loads remain above the intended targets. Use the closed
   `Server-Timing` spans to choose the next bottleneck; do not hide the delay with optimistic copy
   or weaken complete-row/count behavior.
3. Re-run a complete authenticated OpenSpell click-through after deploying a current revision.
   Cover loaded, empty, partial, stale, settling, error, and permission states; both themes;
   keyboard operation; exact exports; and realistic row counts.
4. Repeat the equivalent read-only workflows in AdLabs and SYNQ, then classify differences as
   correctness, missing capability, interaction friction, unnecessary complexity, hierarchy, or
   polish. Do not modify competitor state or copy unsafe push behavior.
5. Reconcile the large current-state drift in `docs/STATUS.md` only after live deployment and QA.

## Recommended continuation order

1. Obtain operator-attended read-only access to the exact hosted database and reconcile the ledger,
   schema, locks, row counts, indexes, and RLS without exposing credentials or row data.
2. Apply only the exact authorized hosted migrations through the documented operator procedure and
   record sanitized count/RLS evidence.
3. Update or rebase PR #81 onto current main, require exact integration CI, and merge only after its
   schema-first gate is proven.
4. Deploy a revision-stamped web candidate from clean main, complete authenticated QA, and promote
   only after the candidate revision and route artifacts match.
5. Stage the merged Evo report worker from that exact clean main revision. Transfer Vercel report
   claims first, prove the legacy unit retired, then perform the attended activation and exact
   health/queue checks. Never allow overlapping consumers.
6. Activate the bounded Creative pilot and reconcile authoritative Asset IDs and every count.
7. Keep the merged Unified Reporting dual-run off until its exact hosted migration, binding,
   deployment revision, consumer ownership, bounded deployment allowlist, exact five-type Evo
   health contract, and separately authorized read-only provider probe are proven. Do not add
   download or promotion behavior from request-status parity alone.
8. After PR #81 clears its overlapping web files, implement the sidebar-scroll regression package.
9. Continue the useful old-PR slices in dependency order: WP-179's inert Sponsored Products
   contract and WP-180's inert provider adapter are merged; next reconcile the hosted ledger and
   obtain exact migration authorization before the persistence slice, then implement the worker
   slice behind a separate gate. Close PR #24 after its distinct work is preserved. Follow with
   WP-184 distinctive release-artifact assertions; the contextual-negative rescue is complete.
10. Reconcile status, deployed revisions, migrations, open PRs, branches, and worktrees again.

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
