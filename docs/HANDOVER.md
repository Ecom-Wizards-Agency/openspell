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

- `origin/main` is `56088492e1a727e2d2ec3a9966d0d27724a01941`. WP-186 merged through PR
  #100 after exact-head run `33492048378` passed both jobs at
  `5a3ea64a7740160c0bd636357cae6765c64816dd`; exact-main run `33493274146` then passed
  repository and Playwright jobs on the actual two-parent merge.
- Vercel reports the latest production-target deployment READY at
  `44da7ac32e5a0503993e567c41aaccffd5c39b06`, 33 commits behind current main. No later package
  deployed or promoted a candidate, so its newer source artifacts are not live evidence.
- Production MCP health identifies `b5c210dca2c28576180223dbe853e61ae7092e73`, 173 commits behind
  current main, and still returns the legacy `wizard-ads` service shape.
- The new Evo report-worker unit is not installed and its loopback health is unavailable. The
  legacy integration worker is active but exposes no revision stamp. Its recent journal has
  recurring Keepa `/product` failures, so exact source revision and integration health are both
  unproven.
- Current source, deployed web, deployed MCP, and the active worker are not one proven release. Do
  not describe post-deployment main features as live until a revision-stamped candidate is promoted
  and checked.
- `docs/STATUS.md` now records WP-179 through WP-186, but the implementation-wave table remains
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
  bootstrap; the hosted migration is now present, while binding and activation remain unverified;
- inactive campaign-creation plans, approvals, write-ahead evidence, closed accounting, and exact
  observation-gated dependencies; no creation job is active and no provider runtime exists;
- inert, guarded Sponsored Products update-plan contracts under the explicit
  `@wizard-ads/shared/sp-writes` subpath, with exact fingerprints, bounded provider accounting,
  complete placement-state evidence, and no job, migration, provider call, or worker activation;
- an inert Sponsored Products provider adapter under the explicit
  `@wizard-ads/ads-api/sp-write-adapter` subpath, with complete observation, marketplace decimal
  policy, one-attempt mutation transport, strict indexed-result closure, cancellation-safe
  credentials, and no worker consumer or live provider activation;
- bounded five-second transactional lock waits on every migration that was pending before the
  attended four-file hosted push, plus a source guard that prevents later lock-sensitive migrations
  from silently removing or moving that boundary;
- exact authenticated relation-privilege hardening for 77 public RLS roots and seven sequences,
  fail-closed `postgres` creator defaults, an advisory DDL protocol for later migrations, and
  executable upgrade and drift refusal proofs. This is merged source only: its hosted migration has
  not been authorized or applied;
- a revision-bound distinctive-release verifier with exact official-SVG byte proof, rendered Grid
  and Recommendations capability checks, locked GET-only Vercel transport, and deterministic
  privacy-safe evidence that grants no deployment or promotion authority. It is merged source only;
  no WP-184 candidate was deployed, verified, or promoted;
- a complete, bounded contextual-negative decision queue with explicit accept, dismiss and reopen,
  review-preserving refresh, and immutable exact-byte JSON/CSV evidence export. It remains an
  operator review/export workflow: it does not enqueue or apply an Amazon action. Its hosted
  migration is present, but a matching web deployment was not performed;
- default-off password recovery, TOTP, passkey, and provider-login security paths. Provider rollout
  remains separately gated.

These are source outcomes, not blanket claims of live behavior.

## Current pull requests

Reconcile heads and checks again before acting.

### PR #81 — WP-171 weekday schedules

- Head at handover preparation: `755926b17ab1988abd138955f6e72020cc89af29`; GitHub reports it
  mergeable, ten commits ahead of its merge base and two current-main commits behind.
- Replaces ambiguous cadence intervals with profile-local weekday, local-time, and timezone
  controls for optimization groups.
- Local `pnpm check` and exact-head run `33477450815` passed both jobs against WP-185 main. The head
  predates WP-186, so update or rebase it onto current main now and require both jobs on the
  resulting exact integration SHA before opening the WP-186 hosted gate.
- The latest head isolates the optimization-group workflow in a fresh authenticated Next process.
- The hosted ledger includes `20260830180000_optimization_weekday_schedules.sql`, and schema-only
  and aggregate-only data postflight confirms its new objects, RLS shape, single canonical disabled
  group backfill and zero post-migration recommendation activity. Do not merge before final
  current-main integration jobs pass; the new web code reads the new columns unconditionally.
- PR #40 and its remote branch were closed/deleted because this package supersedes them.

### Older open work that needs an explicit decision

- PR #24: guarded Sponsored Products write gateway; 130 commits behind, conflicting, and failing.
  WP-179 and WP-180 supersede its shared-contract and provider-adapter portions. Preserve only its
  still-distinct persistence and worker ideas through current, separately reviewed slices, then
  close the old PR.
Do not keep stale pull requests merely as storage. Preserve useful design in a current brief,
replace or rebase live work, and close branches that are proven superseded.

PR #17 and its remote branch were closed/deleted after PR #93 preserved the distinct
contextual-negative workflow on current main with stricter capacity, audit, tenant, and immutable
artifact guarantees. PR #35 was closed after PR #97 preserved and strengthened its distinct
release-artifact requirements on current main.

## Hosted migration gates

The authenticated Supabase CLI 2.116.0 ledger now matches 40 versions in the isolated
fetched-history workdir through `20260901000000_contextual_negative_review_exports.sql`. It
includes the four earlier feature, SP-API and SB Video migrations plus the attended four-file push
of:

- `20260830170000_marketing_stream_correctness.sql`;
- PR #81's `20260830180000_optimization_weekday_schedules.sql`;
- `20260831100000_unified_reporting_dual_run.sql`;
- `20260901000000_contextual_negative_review_exports.sql`.

Beyond the persistent historical ledger filename remapping, repository and hosted content have two
current logical skews: hosted contains PR #81's `20260830180000` file before that branch is on main,
while current main contains WP-186's pending `20260901010000` file. Integrating PR #81 and applying
WP-186 will close those two content skews; it will not make the literal hosted and repository
migration directories identical. The ledger-compatible fetched-history workdir remains the only
hosted deployment artifact.

The push completed in filename order. Schema-only postflight confirms expected objects, columns,
constraints, indexes, grants and RLS definitions with no blocking locks. Guarded browser postflight
then returned the exact sanitized aggregates: audit rows/groups/daily/anchored/ambiguous were
`1/1/0/1/1`; group rows/disabled/populated-weekdays/canonical-weekdays/disabled-next-run-null were
`1/1/1/1/1`; post-marker recommendation runs/contextual runs/jobs were `0/0/0`. Every query was
transaction-read-only and returned no IDs or row data.

Keep optimizer-group edits and manual or scheduled recommendation-job creation frozen until the
weekday-aware worker and web revisions are deployed and verified. The automatic scheduled-run gate
remains off; schema presence did not activate it.

Current main adds one unapplied file:
`20260901010000_authenticated_relation_privilege_hardening.sql`. Its exact bytes were staged in the
isolated fetched-history workdir and a successful dry run proposed only that file. Applying it
requires the exclusive schema-change window in WP-186: pause and drain every partition/retention or
backfill DDL producer, drain schema-capable and idle transactions, prohibit concurrent DDL, obtain
exact operator authorization for this target and file, run the operator procedure, and keep the
freeze through exact ACL, owner, default-privilege, ledger, count, lock and queue postflight.

Do not repair migration history, pull hosted schema into the repository, replay an applied file, or
deploy code that assumes a schema until its exact source and postflight are proven. The guarded
broker/browser route is the normal access path; direct secret injection is neither required nor
permitted.

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
bounded pilot. The two SB Video migrations are present in the hosted ledger, but the path is not
proven automatically active in production. Activation still requires:

- exact hosted schema and preserved-count postflight;
- the exclusive Evo report lane;
- all three Creative producer gates and a deployment-only pilot allowlist;
- one authorized read-only profile probe;
- source/ad/creative/asset/report/mapped/upsert count reconciliation;
- live UI verification against authoritative Amazon Asset IDs.

PR #86 merged the lifecycle-aware automatic-sync copy at `2154b5a65ab7e795ff5aa1456c149569444fa14c`.
It remains source-only until a matching web revision is deployed and verified live.

### SQP and Query Intelligence

The pure SP-API client, weekly planning, taxonomy, vocabulary approval, resumable checkpointing,
spend-conserving joins, review proposals, complete bounded decision queue, and immutable evidence
exports exist in source. The feature, binding and review/export migrations are present in the
hosted ledger. Live weekly execution still needs deployment-owned LWA configuration, tenant
bindings, a revision-matched runtime, and one counted read-only report parity check. Do not
substitute Ads API search-term data for authoritative Brand Analytics SQP, and
do not describe exported negatives as applied to Amazon.

### Dayparting

The raw/revision ledger, normalized hourly facts, DST-local view, settling states, confidence
shrinkage, schedule proposal, and export surfaces exist. Automatic execution remains out of scope.
The hosted correctness migration is present. Live data still needs an AWS SQS/Marketing Stream
subscription with message, revision, normalization, duplicate, and acknowledgement counts.
Advertising API daily reports are not authoritative hourly Marketing Stream data.

### Unified Reporting

WP-181 adds the worker-owned, default-off dual-run coordinator on top of PR #82's strict transport.
It accepts only `spCampaigns`, binds the advertiser explicitly, stores each provider outcome
separately, and leaves Reporting v3 as the sole fact and promotion authority even when Unified
Reporting is ambiguous. The hosted migration is present; tenant bindings, deployment and activation
remain open. Activation separately requires a bounded deployment allowlist, the exact
five-type Evo health contract, and authorization for the exact read-only provider probe. Ground
provider downloads, fact equivalence, history, and any hourly availability with primary evidence
before extending this boundary.

### Optimizer and Time Machine

Stateful recommendation evidence, synchronization observation, hold/continue/revert decisions,
conflict-safe inverse exports, bounded campaign windows, and persistent groups exist. WP-171 makes
schedule intent operator-readable. Its hosted migration and aggregate data-state postflight are
proven, but current-main integration remains open. A complete live reversion remains unproven until
an eligible export batch exists. Any Amazon application or reversion must satisfy the guarded write
contract and an exact current-task authorization.

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

1. Update or rebase PR #81 onto current main without changing its already-hosted migration bytes,
   require exact integration CI, merge, and require exact-main CI. Keep optimizer edits and
   recommendation-job creation frozen until its consumers are deployed and verified.
2. Rebuild or revalidate the isolated 41-file fetched-history workdir and require a dry run that
   proposes only WP-186's migration. The normal repository migration directory is not the hosted
   deployment artifact because historical filenames differ.
3. Establish WP-186's exclusive schema-change window, obtain exact authorization for its sole
   pending migration, apply it through the operator procedure, and retain the freeze through exact
   privilege, ledger, count, lock and queue postflight.
4. Stage the weekday-aware Evo report worker from that exact clean main revision. Transfer Vercel
   report claims first, prove the legacy unit retired, then perform the attended activation and
   exact health/queue checks. Never allow overlapping consumers, and keep the optimizer freeze.
5. Deploy a revision-stamped web candidate from the same clean main, complete authenticated QA, and
   promote only after the candidate revision and route artifacts match. Release the optimizer-edit
   and recommendation-job freeze only after every job-claiming worker and the web are both proven
   weekday-aware.
6. Activate the bounded Creative pilot and reconcile authoritative Asset IDs and every count.
7. Keep the merged Unified Reporting dual-run off until its binding, deployment revision, consumer
   ownership, bounded deployment allowlist, exact five-type Evo health contract, and separately
   authorized read-only provider probe are proven. Do not add download or promotion behavior from
   request-status parity alone.
8. After PR #81 clears its overlapping web files, implement the sidebar-scroll regression package.
9. Continue the useful old-PR slices in dependency order: WP-179's inert Sponsored Products
   contract and WP-180's inert provider adapter are merged; the shared lifecycle correction remains
   frozen until its narrow manager signoff, then persistence and worker slices each receive separate
   review and runtime gates. Close PR #24 after its distinct work is preserved. WP-184's
   distinctive release evidence and the contextual-negative rescue are complete in source; their
   remaining deployment and live-verification gates remain separate.
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
