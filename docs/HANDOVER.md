# OpenSpell continuation handover

Last reconciled: 2026-09-02. This is a rolling handover for the next implementation chat, not a
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

- `origin/main` is `82911581a3e91556c93f12d973509f0acaa94b35`. PR #113 merged WP-191's
  architecture-only token-fenced SP outbox protocol. Exact-head run `33582983015` passed both jobs
  at `fd47827` on its first attempt; exact-main run `33583810523` passed both jobs at the merge
  revision on its first attempt. High correctness and Extra-High adversarial reviews reported no
  blocker, high or medium finding. The package changed no migration, app, job, provider path,
  hosted schema, deployment or activation.
- Production web health returns `ok` at
  `44da7ac32e5a0503993e567c41aaccffd5c39b06`, 75 commits behind current main. No later package
  deployed or promoted a candidate, so its newer source artifacts are not live evidence.
- Production MCP health identifies `b5c210dca2c28576180223dbe853e61ae7092e73`, 215 commits behind
  current main, and still returns the legacy `wizard-ads` service shape.
- The new Evo report-worker unit is not installed and its loopback health is unavailable. The
  legacy integration worker is active, but exposes no revision stamp. Earlier in this continuation
  it restarted after an uncaught `claimSyncJobs` statement timeout. The operator then completed an
  attended stop/start and observed `NRestarts=0`; final read-only reconciliation found the service
  active/running with a new process and `NRestarts=1` again. The unprivileged journal exposed no
  cause for that latest restart. WP-189 contains direct claim-RPC `57014` failures in source, but
  the active service revision remains unproven, so that protection and full integration health are
  not live evidence.
- Current source, deployed web, deployed MCP, and the active worker are not one proven release. Do
  not describe post-deployment main features as live until a revision-stamped candidate is promoted
  and checked.
- `docs/STATUS.md` now records WP-179 through WP-191, but the implementation-wave table remains
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
- a default-empty Sponsored Products write-persistence ledger with immutable exact-byte evidence,
  versioned environment/profile authority, authenticated approvals, single-winner write-ahead
  reservation, stable result/recovery identity, derived accounting, tenant isolation and
  concurrency-safe purge behavior. Its migration is merged source only; no hosted schema, job,
  worker consumer, provider call, deployment or live mutation was activated;
- an inert typed database facade for that ledger under the explicit
  `@wizard-ads/db/sp-write-persistence` subpath. It separates staging from runtime capabilities,
  requires committed reservation readback before issuing an opaque in-process dispatch ticket,
  verifies exact evidence and accounting, maps failures to controlled categories, and adds no job,
  worker/provider reachability, migration, deployment setting or activation;
- a one-shot, single-flight generic worker claim loop that contains only direct PostgreSQL `57014`
  claim-RPC cancellations with capped equal-jitter backoff, preserves running work, drains an active
  claim safely on shutdown, and reports sanitized lifecycle health. Its real-PostgreSQL proof shows
  the canceled claim rolls back completely before the same job completes once. It is merged source
  only: no deployed worker revision, queue owner, job type, migration, provider call or SP-write
  activation changed;
- test-only browser-process isolation that preserves the same 69 tests while running 11 named
  suites in fresh serial processes. Exact route-manifest conservation, crash-safe setup/cleanup,
  one worker, zero retries and the explicit 4 GB heap cap are enforced; no application behavior,
  authentication rule, migration, deployment or runtime activation changed;
- an accepted architecture for token-fenced SP outbox delivery using private mutable custody heads,
  immutable transition journals, typed non-JSON claim credentials, database-clock ownership,
  claim-bound dispatch-lease and reservation wrappers, exact completion/error semantics and
  separately gated source, coordinator and activation packages. It is documentation only; no
  schema, facade implementation, worker consumer, provider reachability or runtime activation was
  added;
- bounded five-second transactional lock waits on every migration that was pending before the
  attended four-file hosted push, plus a source guard that prevents later lock-sensitive migrations
  from silently removing or moving that boundary;
- exact authenticated relation-privilege hardening for 77 public RLS roots and seven sequences,
  fail-closed `postgres` creator defaults, an advisory DDL protocol for later migrations, and
  executable upgrade and drift refusal proofs. Its sole hosted migration was applied through the
  attended exclusive window and passed exact ledger, ACL, row, policy, lock, queue and recovery
  postflight;
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

There are no open pull requests. PR #24 was closed unmerged at archival head `78e718b` after
WP-191 preserved its remaining token-fenced ownership/recovery lesson on accepted current main.
Its superseded source was not rebased, cherry-picked or merged.

Do not keep stale pull requests merely as storage. Preserve useful design in a current brief,
replace or rebase live work, and close branches that are proven superseded.

## Hosted migration gates

The authenticated Supabase CLI 2.116.0 ledger now matches 41 versions in the isolated
fetched-history workdir through `20260901010000_authenticated_relation_privilege_hardening.sql`. It
includes the four earlier feature, SP-API and SB Video migrations plus the attended four-file push
of:

- `20260830170000_marketing_stream_correctness.sql`;
- PR #81's `20260830180000_optimization_weekday_schedules.sql`;
- `20260831100000_unified_reporting_dual_run.sql`;
- `20260901000000_contextual_negative_review_exports.sql`.

PR #81 is on main and WP-186 is in the hosted ledger, so the two prior logical content skews are
closed. Persistent historical filename remapping still means the literal hosted and repository
migration directories are never the deployment comparison. The ledger-compatible fetched-history
workdir remains the only hosted deployment artifact.

The push completed in filename order. Schema-only postflight confirms expected objects, columns,
constraints, indexes, grants and RLS definitions with no blocking locks. Guarded browser postflight
then returned the exact sanitized aggregates: audit rows/groups/daily/anchored/ambiguous were
`1/1/0/1/1`; group rows/disabled/populated-weekdays/canonical-weekdays/disabled-next-run-null were
`1/1/1/1/1`; post-marker recommendation runs/contextual runs/jobs were `0/0/0`. Every query was
transaction-read-only and returned no IDs or row data.

Keep optimizer-group edits and manual or scheduled recommendation-job creation frozen until the
weekday-aware worker and web revisions are deployed and verified. The automatic scheduled-run gate
remains off; schema presence did not activate it.

WP-187's `20260901020000_sp_write_persistence_ledger.sql` is merged source only and was not added to
the hosted ledger. WP-188 added only a source facade and did not apply or assume that migration. Do
not apply it as part of a worker or outbox slice; a future hosted apply requires a separately
reconciled ledger-compatible artifact, exact action authorization and pre/postflight. Its absence
keeps every new persistence relation and capability unavailable live.

WP-191 added architecture documents only. Its database/facade successor may add one inert forward
migration after rechecking the exact last source migration, but must not host WP-187 or that new
migration, import the facade from an app, register a consumer, reach the provider or activate a
write gate in the same package.

WP-186 was applied from the isolated 41-file artifact at SHA-256
`db3def960f433c1e221c0257aacd3551e8c7b023fd178a078831ba2a038b7e2c`. The attended window stopped
the legacy worker and paused only cron jobs 3 and 4. Preflight captured 77 roots, seven sequences,
230 partitions, 157 policies, 1,578,190 rows, exact platform and non-target ACL fingerprints, zero
schema-capable transactions and zero blocking or exclusive locks. Postflight proved the 41st ledger
row with all 27 statements, unchanged rows, policies, partitions, platform defaults, non-target
ACLs and queue aggregates, zero `postgres` target defaults, and exact direct and effective table,
column, partition and sequence authority. Both cron jobs were restored to the exact recorded
schedule, command, database, user and active state; the worker
was manually restarted and reconnected. That postflight saw `NRestarts=0`; the current snapshot
above records the later automatic restart.

Do not repair migration history, pull hosted schema into the repository, replay an applied file, or
deploy code that assumes a schema until its exact source and postflight are proven. Guarded broker,
browser and authenticated project-scoped CLI routes are the normal access paths; direct secret
injection is neither required nor permitted.

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
schedule intent operator-readable. Its hosted migration, aggregate data-state postflight,
current-main integration and exact-main CI are proven; revision-matched worker/web deployment and
authenticated QA remain open. A complete live reversion remains unproven until an eligible export
batch exists. Any Amazon application or reversion must satisfy the guarded write contract and an
exact current-task authorization.

## Known UX and performance follow-ups

1. When every navigation group is expanded, the active marker and utility footer collide because
   the entire sidebar owns scrolling while the footer is also pushed with auto margin. Fix in a
   fresh serialized web package: keep brand/footer non-shrinking, give only the main
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
5. Fill the remaining WP-149–178 implementation-wave gaps in `docs/STATUS.md` during the next live
   deployment/QA reconciliation, using Git, CI and runtime evidence rather than inferred status.

## Recommended continuation order

1. Implement the separately numbered inert WP-191 database/facade successor from exact current
   main. Add only the private delivery head/journal, controlled claim transitions, claim-bound
   dispatch-lease/reservation wrappers, tokenless grant revocations, explicit DB facade and focused
   proofs. Keep both SP migrations unhosted, add no app/job/provider reachability and leave every
   runtime gate closed. Use High for implementation correctness and Extra High for migration,
   stale-token, lock-order, purge and no-redispatch review.
2. Stage the weekday-aware Evo report worker from an exact clean main revision. Transfer Vercel
   report claims first, prove the legacy unit retired, then perform the attended activation and
   exact health/queue checks. Never allow overlapping consumers, and keep the optimizer freeze.
3. Deploy a revision-stamped web candidate from the same clean main, complete authenticated QA, and
   promote only after the candidate revision and route artifacts match. Release the optimizer-edit
   and recommendation-job freeze only after every job-claiming worker and the web are both proven
   weekday-aware.
4. Replace or revision-stamp the MCP deployment from the same proven release and repeat its
   read-only health, tool and audit verification before claiming runtime coherence.
5. Implement the sidebar-scroll regression now that WP-171 no longer overlaps its web files.
6. Activate the bounded Creative pilot and reconcile authoritative Asset IDs and every count.
7. Keep the merged Unified Reporting dual-run off until its binding, deployment revision, consumer
   ownership, bounded deployment allowlist, exact five-type Evo health contract, and separately
   authorized read-only provider probe are proven. Do not add download or promotion behavior from
   request-status parity alone.
8. Keep WP-184's distinctive release evidence and the contextual-negative rescue separate from
   their remaining deployment and live-verification gates.
9. Reconcile status, deployed revisions, migrations, open PRs, branches, and worktrees again.

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
