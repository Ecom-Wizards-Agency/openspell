# OpenSpell continuation handover

Last reconciled: 2026-09-04. This is a rolling handover for the next implementation chat, not a
historical changelog.

This is an operator-requested interim continuity checkpoint under the narrow WP-201 documentation
exception. It records verified state and open work only; it does not complete WP-201, satisfy an
acceptance row, update rolling status or authorize any external action.

## Human status and visible plan

OpenSpell is not one release away from the full intended product. The repository contains a large
amount of reviewed source, but production still runs an older, unmatched web/MCP/worker set. The
next useful product milestone is the live campaign-scoped optimization preview; direct Amazon
application and complete multi-product campaign creation remain later implementation milestones.

Current stage:

- [x] WP-200 and all preceding source are merged. WP-206 safely recovered the only two useful
  legacy-branch behaviors without importing its lineage, and exact-main CI is green at current
  `origin/main` `560d5e28615ea023f020f1a3d0944dff96213981`.
- [x] WP-201's initial architecture plus the root-authority implementation checkpoint culminate at
  `c36b680e0ee7a4f5e71382c011c613902db2cdfa`; this later commit is documentation-only.
- [ ] Before more step-3 implementation, commit and independently review an architecture-and-brief
  exactness amendment. It must freeze the invocation-directory prefix, Docker label keys and role
  values, acquisition network, container mount destinations, vendor-ledger byte framing,
  event-helper descriptor/control protocol, pinned proof-image digest and per-manifest Cargo command
  matrix. The current architecture fixes the safety constraints but not those concrete values.
- [ ] Finish WP-201 step 3 by implementing and proving the amended root/container composition
  boundary. The coordinator-owned root proof is required by source acceptance and is the remaining
  executable proof for the newly committed bridge. Do not begin step 4 before its production uid-0
  call chain and procfs mount attack matrix pass.
- [ ] Commit and independently review WP-201's remaining v2 record/transition/domain contract, then
  implement its private preparation machine, target/credential/gateway/egress/history/dry-run
  models, exhaustive cuts and live-route absence proof. Apply remains absent from WP-201.
- [ ] Push WP-201 only after the full package is reviewed and verified; require exact-head CI,
  merge, exact-main CI, and only then mark it complete in rolling status.
- [ ] WP-202: prove disposable apply, lock handoff, lost-response reconciliation and every valid
  41-through-46 migration prefix on a separately authorized disposable target.
- [ ] WP-203 through WP-205: build the immutable deployment artifact, prove disabled staging,
  perform separately authorized production preparation, and apply the exact five-migration artifact
  with complete postflight.
- [ ] Provision the narrow recommendation credential; stage and activate revision-matched report
  and recommendation workers; deploy a matching candidate; admit scoped preview traffic; run
  authenticated campaign-checkbox/Run-preview QA; then promote web and revision-stamp MCP.
- [ ] Activate and verify the read-only Sponsored Brands Video Creative pipeline with one bounded
  profile pilot and exact source/parsed asset and ad counts; mapped/legacy/unsupported/ambiguous/
  unmapped states; report source/parsed/refused/mapped/unpromoted rows; asset/mapping/snapshot/fact
  upserts; and persisted read-back counts.
- [ ] Implement the guarded Amazon optimization executor: immutable approved batch, explicit
  first-write profile activation, one-attempt worker dispatch, partial-result accounting,
  resynchronization and conflict-safe inverse write. Exports remain evidence, not application.
- [ ] Implement direct multi-product campaign creation (SP/SB/SBV/SD). Retain the complete
  read-only Asset Library search; add upload/register and version-aware selection, product create
  adapters and compilers, persistence/projection, guarded worker execution, guided approval UI and
  separate bounded live evidence. No product currently has a direct creation runtime; the existing
  SP builder previews and exports a bulksheet only.

Practical distance, expressed as gates rather than calendar promises:

- **Campaign checkbox + Run preview:** source exists; the five WP-201–205 migration/deployment
  safety prerequisites plus the revision-matched activation and QA sequence remain.
- **Creative Performance:** the read UI and ingestion source exist; the exclusive report lane,
  deployment gates, pilot and live Asset-ID/count proof remain. This is closer than SB campaign
  creation.
- **Direct SP optimization apply:** write contracts, client adapter, ledger and outbox source exist,
  but hosted schema, worker executor, approval/activation UI and one bounded observed live cycle are
  still missing.
- **Multi-product campaign creation (SP/SB/SBV/SD):** architecture/contracts and read-only Asset
  Library search exist, but no direct creation runtime exists. Upload/register, version-aware asset
  selection, product create adapters/compilers, persistence/projection, worker execution, approval
  UI and live evidence remain. This is a later product wave, not an activation-only task.

When resuming, use goal mode with this objective: **Continue OpenSpell from `docs/HANDOVER.md` in
the visible dependency order, keeping source, hosted schema, deployment, activation and live proof
as separate states.** If goal mode is unavailable, keep this checklist visible and update it after
each verified checkpoint.

### Fast resume for another agent

1. Read `AGENTS.md`, this file, `docs/workpackages/WP-201-disposable-preparation-proof.md` and
   `docs/design/WP-201-ARCHITECTURE.md` completely.
2. Run `git worktree list --porcelain`. Use the worktree whose `branch` field is
   `refs/heads/wp-201-disposable-preparation`. The original worktree should remain clean on `main`;
   the obsolete `codex/onepassword-secrets` ref was safely removed by WP-206.
3. Verify the WP-201 branch contains `c36b680e0ee7a4f5e71382c011c613902db2cdfa` and the worktree
   is clean, fetch and reconcile `origin/main`, the current set of open PRs and exact-main CI, and
   recheck live health before trusting the counts below.
4. Treat the hosted ledger as last verified at 41 migrations on 2026-09-01. Do not query or mutate a
   hosted project without fresh action-specific authorization.
5. Before the remaining step-3 container-wrapper implementation, freeze the known concrete
   Docker/proof values enumerated in the first unchecked item in an architecture-and-brief
   amendment and review its exact hash. Then implement the amended root/container proof before
   starting step 4. Follow the remaining unchecked list in order. Use High for bounded
   implementation and one High plus two independent Extra-High reviews for security, crash,
   migration, deployment and Amazon-write boundaries.
6. Do not push or open a PR for the current partial WP-201 package merely to preserve it: all work is
   committed locally. Push only when the package's documented source slice and reviews are complete,
   unless the operator explicitly asks for a draft remote backup.

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
- Every successfully synced profile should appear as manageable in the product, but requires an
  explicit first-write activation before any mutation. After activation, supported, explicitly
  approved batches apply through the worker directly to Amazon; exports are evidence or rollback
  artifacts, not the application path.
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

- WP-200 is merged and closed out at
  `51a56b392ab524dc140e343fe1dc87b58e17c42f`. PR #131 added the
  fixed official-release policy, descriptor-only custody verifier and synthetic Linux
  namespace/cgroup/pidfd/ptrace/exec-map and process-protection proof. PR #132 fixed deterministic
  proof-builder cold-run acquisition with commit-pinned
  actions, one exact digest pull, exact local image-ID custody, `--pull=never`, bounded asynchronous
  preflight and composed workflow deadlines. Exact-head run `33817286905`, exact-main run
  `33818382351` and trusted-main kernel run `33819407467` all passed on their exact revisions. High
  correctness and two Extra-High authority/crash/cleanup reviews ended clean. Focused proofs passed
  34 Rust and eight TypeScript tests, 19 real Linux cases and five real interruption cuts with zero
  residue. The package remains a private nondeployable `rlib`; it has no production launcher,
  external target, credential, listener, service, database connection, Supabase operation or apply
  capability. Official CLI acquisition and complete official runtime/release provenance remain
  later gates. Exact-main CI run `33821396062` and trusted-kernel run `33822223884` passed on
  `51a56b392ab524dc140e343fe1dc87b58e17c42f`. WP-206 then merged through PR #134 at current main
  `560d5e28615ea023f020f1a3d0944dff96213981`: it manually reimplemented API-key timestamp
  normalization and Roadmap overflow containment, added ignore boundaries for operator-local
  metadata, and imported no obsolete runtime lineage. Exact-head CI run `33856798694` and
  exact-main CI run `33857804641` passed; the triggered trusted-kernel run `33859029788` also
  passed on that exact main revision.
- WP-201 is local and unmerged on branch `wp-201-disposable-preparation`. Six implementation
  commits culminate at `c36b680e0ee7a4f5e71382c011c613902db2cdfa`, defining the initial
  architecture and implementing the root-authority portion of step 3; this later standalone
  documentation checkpoint follows them. The final 15-file Rust checkpoint passed format,
  check, Clippy with warnings denied and rustdoc in both feature modes; 86 no-feature Rust tests,
  117 `wp201-internal` Rust tests and 14 TypeScript tests passed. One High correctness reviewer and
  two Extra-High authority/crash reviewers ended clean on exact staged hash
  `3d881b1996aa9b3adac51f983f5cc2f3bb99ab901c6fa26b451db3431dc8e68f` before commit. It adds the
  root-owned authority registry, shared v1/v2 OFD super-lock, empty v2 journal, exact descriptor
  graph revalidation, independent signed vectors and real crash/race proofs. It remains a private,
  nondeployable, source-only library with no target, credential, listener, database connection,
  hosted query, dry run or apply capability. The branch is not pushed, has no PR or hosted CI, and
  must not be described as merged.
- Production web health returns `ok` at
  `44da7ac32e5a0503993e567c41aaccffd5c39b06`, 177 commits behind current main. No later
  package deployed or promoted a candidate, so its newer source artifacts are not live evidence.
- Production MCP health identifies `b5c210dca2c28576180223dbe853e61ae7092e73`, 317 commits behind
  current main, and still returns the
  legacy `wizard-ads` service shape.
- The new Evo report-worker and recommendation-worker units are not installed, so their loopback
  health is unavailable. The legacy integration worker is active, but exposes no revision stamp.
  Earlier in this continuation
  it restarted after an uncaught `claimSyncJobs` statement timeout. The operator then completed an
  attended stop/start and observed `NRestarts=0`; final read-only reconciliation found the service
  active/running with a new process and `NRestarts=1` again. The unprivileged journal exposed no
  cause for that latest restart. WP-189 contains direct claim-RPC `57014` failures in source, but
  the active service revision remains unproven, so that protection and full integration health are
  not live evidence.
- Current source, deployed web, deployed MCP, and the active worker are not one proven release. Do
  not describe post-deployment main features as live until a revision-stamped candidate is promoted
  and checked.
- `docs/STATUS.md` records WP-179 through WP-200, but its reconciliation header still names
  `f06efea` rather than current main `560d5e2`, and the implementation-wave table remains incomplete
  between WP-149 and WP-178. WP-201 must not be added until it is merged and exact-main CI passes.
  Use Git, CI, code, the migration ledger and live health as evidence before updating status prose.

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
- source-only report-claim custody that serializes legacy and fenced claims on one private one-way
  authority, treats uncertain provider effects as quarantine, bounds download/parser resources and
  final audit output, and refuses activation or rollback when exact custody/revision proofs fail. Its
  migration is not hosted and the new worker remains absent;
- source-only campaign-scoped optimizer previews with native campaign checkboxes, cross-page
  filtered selection, explicit all-versus-selected modes, one idempotent parent batch, immutable
  per-group and unassigned child scopes, exact queue-job custody, bounded polling and honest
  terminal state. The migration is not hosted and no compatible worker or web revision is live;
- source-only exclusive recommendation claim custody with one private authority, a narrow
  recommendation-only database principal and RPC facade, claim-bound run mutations, a dedicated
  single-flight database-only worker, strict web readiness and revision-pinned Evo deployment
  controls. Its migration is not hosted, its credential is not provisioned, and its worker is not
  staged or active;
- an offline exact hosted-migration bundle builder and independent verifier that deterministically
  reconstruct the reviewed 41-file hosted baseline plus the five exact Git blobs as a 46-file
  artifact, with rollback-only prefix evidence and no database, network, Supabase or apply
  capability. It authorizes no hosted action;
- a pure hosted-migration conformance oracle that verifies the eight exact WP-197 signed record
  families, canonical bytes, detached signatures, operation-private phase tags, pinned official CLI
  topology, runtime-attestation chains and legal transcript transitions. It has no CLI or external
  capability and cannot authorize, launch or attest a live operation;
- a private source-only root journal and fixed nonmultiplexed IPC boundary that durably binds exact
  candidate, approval-grant and one-use execution-ticket transitions, refuses replay and ambiguous
  recovery, and exposes no binary, listener, launcher, external target or production signer;
- a private, nondeployable hosted-CLI runtime proof that can verify already-open release assets
  against fixed facts and returns only incomplete official runtime components, then exercises
  complete fixed synthetic Linux namespace, cgroup, pidfd, ptrace,
  exec-map, interruption, watchdog and cleanup cases. Its trusted-main cold-run workflow passed on
  current main with exact proof-builder image acquisition and zero residue; it still has no
  external target, credential, database connection, production launcher or apply capability;
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
- source-only token-fenced SP outbox delivery using private mutable custody heads, immutable
  transition journals, typed non-JSON claim credentials, database-clock ownership, claim-bound
  dispatch-lease and reservation wrappers, exact completion/error semantics, tokenless grant
  revocation and purge/lock-order proofs. It remains inert: neither SP migration is hosted and no
  app, worker consumer, provider reachability or runtime activation was added;
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

There are no open pull requests. PR #131 merged WP-200 at `9d932f5`, PR #132 merged its
trusted-runner cold-start correction at `f06efea`, PR #133 closed WP-200 at `51a56b3`, and PR #134
merged the narrow WP-206 safe recovery at current main `560d5e2`. The local WP-201 branch is not
pushed and therefore has no PR or hosted CI. PR #24 remains closed unmerged at archival head
`78e718b` after WP-191 preserved its remaining token-fenced ownership/recovery lesson on accepted
current main. Its superseded source was not rebased, cherry-picked or merged.

Do not keep stale pull requests merely as storage. Preserve useful design in a current brief,
replace or rebase live work, and close branches that are proven superseded.

## Local worktrees and branch safety

Only two worktrees remain:

- the active WP-201 worktree on `wp-201-disposable-preparation`, containing the reviewed
  implementation checkpoint `c36b680`, the handover checkpoint and the merge of current main; and
- the original operator worktree, clean on `main` at `560d5e2`.

WP-206 fully resolved the obsolete `codex/onepassword-secrets` branch. Independent inventory found
two useful behaviors: Roadmap overflow containment and MCP raw-timestamp normalization. Both were
manually reimplemented on current main with focused and real-database tests; no legacy commit was
merged, cherry-picked or pushed. One High and two Extra-High reviews accepted the exact patch,
exact-head and exact-main CI passed, and the local legacy ref was removed with atomic
expected-object compare-and-delete. The merged WP-206 topic ref was also removed. Operator-local
`.1password/` and `supabase/.temp/` contents remain in place and are ignored; obsolete `ops/evo`
runtime work was intentionally discarded. Do not recreate or publish the legacy lineage.

## Hosted migration gates

The last authenticated Supabase CLI 2.116.0 verification, on 2026-09-01, found 41 versions in the
isolated fetched-history workdir through
`20260901010000_authenticated_relation_privilege_hardening.sql`. It includes the four earlier
feature, SP-API and SB Video migrations plus the attended four-file push of:

- `20260830170000_marketing_stream_correctness.sql`;
- PR #81's `20260830180000_optimization_weekday_schedules.sql`;
- `20260831100000_unified_reporting_dual_run.sql`;
- `20260901000000_contextual_negative_review_exports.sql`.

PR #81 is on main and WP-186 is in the hosted ledger, so the two prior logical content skews are
closed. Persistent historical filename remapping still means the literal hosted and repository
migration directories are never the deployment comparison. The ledger-compatible fetched-history
workdir remains the only hosted deployment artifact.

WP-197 now provides a deterministic reviewed source policy for reconstructing and independently
verifying exactly 46 migration files: the same 41-file baseline plus the five exact Git blobs. Its
baseline digest is `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea`; its
final bundle-ledger digest is
`baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`. The tool and its SQL
evidence are offline and inert. They neither establish fresh hosted history nor authorize an apply.

WP-198 verifies the exact signed evidence vocabulary and legal lifecycle transitions expected from
the private supervisor. WP-199 implements the source-only private journal and separate fixed IPC
surfaces through one-use ticket consumption. WP-200 implements the fixed official-release policy
and descriptor-only verifier, while proving only the complete synthetic Linux runtime boundary in a
trusted workflow. The three packages remain nondeployable and cannot authenticate a human, listen,
connect or apply; WP-200's launcher is test-only and synthetic. Official CLI acquisition, complete
official runtime/release provenance, target connection, preparation and every apply capability
remain later gates across WP-201 through WP-205.

The push completed in filename order. Schema-only postflight confirms expected objects, columns,
constraints, indexes, grants and RLS definitions with no blocking locks. Guarded browser postflight
then returned the exact sanitized aggregates: audit rows/groups/daily/anchored/ambiguous were
`1/1/0/1/1`; group rows/disabled/populated-weekdays/canonical-weekdays/disabled-next-run-null were
`1/1/1/1/1`; post-marker recommendation runs/contextual runs/jobs were `0/0/0`. Every query was
transaction-read-only and returned no IDs or row data.

Keep optimizer-group edits and manual or scheduled recommendation-job creation frozen until the
weekday-aware worker and web revisions are deployed and verified. The automatic scheduled-run gate
remains off; schema presence did not activate it.

WP-187's `20260901020000_sp_write_persistence_ledger.sql`, WP-192's
`20260901030000_sp_write_outbox_delivery.sql`, WP-194's
`20260901040000_fenced_sync_claims.sql`, WP-195's
`20260901050000_recommendation_preview_scopes.sql`, and WP-196's
`20260901060000_recommendation_claim_custody.sql` are merged source only and were not added to the
hosted ledger. WP-188 and WP-192 expose source facades but no app imports them, and the fenced
report and recommendation runtimes remain absent. Do not apply any of the five as part of a source
package; a future hosted apply requires a separately reconciled ledger-compatible artifact, exact
action authorization and pre/postflight. Their absence keeps the SP delivery, fenced report custody
and scoped-preview capabilities unavailable live.

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
- exact source/parsed asset and ad counts; mapped/legacy/unsupported/ambiguous/unmapped mapping
  states; report source/parsed/refused/mapped/unpromoted rows; asset/mapping/snapshot/fact upserts;
  and every persisted read-back count;
- live UI verification against authoritative Amazon Asset IDs.

PR #86 merged the lifecycle-aware automatic-sync copy at `2154b5a65ab7e795ff5aa1456c149569444fa14c`.
It remains source-only until a matching web revision is deployed and verified live.

This section describes the read-only Creative Performance feature. It does not mean operators can
upload/register Asset Library media or create Sponsored Brands/SB Video campaigns. Those write-side
features still need the current Asset Library lifecycle, a version-aware picker, Unified SB
client/compiler support, a guarded worker executor and the explicit Amazon creation confirmation.

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

WP-195 now supplies the source implementation for a searchable campaign list with native row
checkboxes, filtered cross-page header selection, global clear, exact selected counts, explicit All
eligible versus Selected campaigns scope, observable parent/child progress and immutable
enqueue-time campaign/policy evidence. WP-196 supplies the exclusive compatible claimant, exact
claim-bound run writes and a fail-closed shared readiness gate in source. The complete preview path
remains unavailable live until all five pending migrations, the narrow worker credential, staged and
activated recommendation service, scoped admission and a matching web revision are separately
authorized, deployed and verified. No Amazon apply path was added. After preview activation, direct
application still requires the guarded worker executor and explicit first-write profile activation;
sync alone must never grant write authority.

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

This sequence orders source design and disposable proof packages only; it grants no external
authority. Target or project creation, credential provision or rotation, hosted query, dry run or
apply, authenticated acquisition, real-host staging, activation or service mutation, and deployment
each require a fresh exact action-specific authorization before that action occurs.

1. Resume the clean local WP-201 branch containing `c36b680`. First commit and review the
   architecture-and-brief exactness amendment for the known invocation-directory, Docker-label,
   acquisition-network, mount-destination, vendor-ledger, helper-protocol, image-digest and Cargo
   matrix gaps. Then implement and prove the amended root/container composition boundary before
   step 4. Next commit and review the remaining v2 record/transition/domain contract and continue
   WP-201's disposable target-scoped credential, egress, hosted-history and dry-run preparation
   boundary with apply absent. Any actual disposable target, credential or hosted preparation
   requires its own exact disposable-only authorization. WP-202 then proves
   disposable apply, the two-stage lock handoff, crash/lost-response reconciliation and every valid
   41-through-46 prefix, again only under a fresh exact disposable-target authorization.
2. Use WP-203 for the immutable deployment artifact and source or synthetic-harness proof of
   disabled-unit stage/activate/rollback behavior. That package work does not authorize staging,
   activating or mutating a real host unit. Then use WP-204 for separately authorized production
   prerequisites, read-only preparation, operation window and enqueue freeze without apply.
3. Only through WP-205 and authorization for that exact database action, apply only the
   WP-197-reviewed artifact and prove ledger, schema, privileges, preserved state and queue
   postflight. Database approval does not authorize staging, service, queue-ownership or deployment
   changes.
4. With separate exact authorization, provision or rotate only the narrow recommendation-worker
   database credential through an allowlisted Writer operation. Do not expose a broad
   service-account token or reuse `service_role`; credential custody does not authorize staging or
   activation.
5. With separate action-specific staging authorization for each exact target, stage the clean-main
   Evo report worker and the independently proven recommendation claimant. Staging must leave
   current service enablement, claim authority and web enqueue unchanged.
6. With separate action-specific activation authorization for each exact handoff, block new
   recommendation enqueue; move report ownership and recommendation ownership independently; prove
   each old claimant retired, each new claimant exclusively healthy, and zero incompatible active
   work; then retain the exact rollback/custody evidence. Never allow overlapping consumers or
   strand `recommendations.run` jobs.
7. With separate candidate-deployment authorization, deploy a revision-stamped candidate from the
   same proven main only after the recommendation claimant is exclusively healthy. Prove its exact
   revision and route artifacts while admission remains blocked; do not create a preview or promote
   the candidate under staging or deployment authority alone.
8. With separate scoped-admission authorization, use only the guarded transition and exact
   pre/postflight to move the proven authority tuple from blocked to scoped. Reconcile a lost
   response by exact tuple readback; never retry blind. This gate does not authorize QA job creation
   or web promotion.
9. With separate bounded-QA authorization, test the candidate's Run preview, cross-page campaign
   selection, reload/resume, refusal and terminal states, and reconcile exact immutable proposal
   counts with zero Amazon action.
10. Only with separate web-promotion authorization, promote the already verified candidate and
   confirm its live revision and route artifacts. Release the optimizer-edit/job-creation freeze
   only after every consumer and the web are revision-matched and weekday-aware.
11. Replace or revision-stamp the MCP deployment from the same proven release and repeat its
   read-only health, tool and audit verification before claiming runtime coherence.
12. Implement the sidebar-scroll regression as the next independent source-only UI slice.
13. Activate the bounded Creative pilot and reconcile authoritative Asset IDs and every count.
14. Keep the merged Unified Reporting dual-run off until its binding, deployment revision, consumer
   ownership, bounded deployment allowlist, exact five-type Evo health contract, and separately
   authorized read-only provider probe are proven. Do not add download or promotion behavior from
   request-status parity alone.
15. Keep WP-184's distinctive release evidence and the contextual-negative rescue separate from
   their remaining deployment and live-verification gates.
16. Reconcile status, deployed revisions, migrations, open PRs, branches, and worktrees again; then
   remove only clean, merged, obsolete worktrees after proving their branch and dirty state.

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
