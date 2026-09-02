# WP-195 — Campaign-scoped optimizer previews

Owner: optimizer database, recommendation worker and optimizer web surface.

Depends on: merged WP-194 closeout and source-only WP-187/WP-192/WP-194 migration ordering.

Architecture: `docs/design/WP-195-ARCHITECTURE.md`.

## Objective

Make `Run preview` work as an observable, read-only operation and add AdLabs-style transient campaign
selection to the main Campaign Optimizer. One operator action may select campaigns across groups while
each campaign retains its own immutable enqueue-time policy.

WP-195 is source-only until separately authorized. It does not apply a hosted migration, deploy web,
stage or activate a worker, call Amazon, mutate an Amazon campaign, export a recommendation, alter
group assignments, recover a production job or clean a production ledger.

## Owned files

- new `20260901050000` preview-batch/scope migration and focused migration tests;
- recommendation run schema/query/store/runner files and focused tests;
- optimizer campaign workspace, run API, polling, page data, styling and focused tests;
- existing isolated optimizer Playwright coverage;
- WP-195 architecture and this work-package brief.

Do not edit `packages/shared`, Ads API, Amazon write gateway/outbox/delivery, campaign generation,
strategy doctrine, earlier migration bytes, seeds, handover or status. Handover and status change only
after reviewed merge, exact-main CI and external-state reconciliation.

## Required behavior

1. Add native campaign-row checkboxes to `/optimizer`; keep `/optimizer/groups` checkboxes exclusively
   for persistent policy assignment.
2. Header selection covers all eligible rows matching current filters across all pages. Hidden
   selections persist, and Clear selected clears the complete transient set.
3. Present explicit All eligible campaigns and Selected campaigns modes with exact counts. Filters
   never redefine All, and zero selection never falls back to All.
4. Make only enabled, nondeleted Sponsored Products campaigns in enabled groups or unassigned state
   selectable. Render an explicit reason for every visible ineligible row and enforce the same rule on
   the server.
5. Bound selected requests to 10,000 unique campaign ids and 512 KiB. Empty, duplicate, foreign,
   stale, ineligible and oversized input rejects atomically without truncation.
6. Create one idempotent parent preview batch and atomically partition it into one child run per
   current group plus an unassigned child. One failed preflight writes no parent, child, scope or job.
7. Persist exact sorted child scope rows, positive counts, domain-separated SHA-256 fingerprints,
   group snapshots, resolved strategy snapshots and queue job identities at enqueue time.
8. Preserve the existing shared recommendation job payload. Campaign ids never enter the queue JSON,
   and the frozen shared package remains unchanged.
9. Verify scope count/fingerprint and policy snapshots before a worker marks a run running. Integrity
   drift is permanent failure with zero recommendations.
10. Load scoped facts through the immutable run membership. Live group assignment, campaign roster or
    strategy edits cannot add, replace or move a campaign after enqueue.
11. Capture the same exact scope for scheduled group runs. New code never enqueues an unscoped run;
    historical rows remain displayable but are not adopted for execution.
12. Poll one tenant-scoped, bounded parent status endpoint without overlapping requests. Retry state
    follows queue evidence; terminal success/failure is never inferred optimistically.
13. Refresh the server page once at terminal state and expose each child run's review link and honest
    partial-failure state.
14. Preserve count assertions, RLS, role gating, public-repo hygiene and v1 no-Amazon-write behavior.

## Proof requirements

- fresh and populated migration replay preserves every existing run/recommendation/job count;
- migration catalog proof covers composite foreign keys, null-aware partition uniqueness, scope shape,
  batch-wide campaign uniqueness, RLS and service-only writes;
- two groups plus unassigned close as one parent, three children, one exact campaign union and three
  jobs;
- all and selected scopes resolve server-side and their sorted count/fingerprint readback matches;
- duplicate, empty, foreign, stale, unsupported, disabled and oversized selections leave zero
  artifacts;
- concurrent identical idempotency requests return one batch; a changed request under the same key
  refuses;
- group assignment/save races produce a complete before-or-after snapshot without mixed membership;
- assignment, strategy, pause, deletion and new-campaign changes after enqueue cannot alter captured
  membership or policy;
- tampered/missing/extra scope evidence fails before running and produces zero recommendations;
- scoped execution emits recommendations only for captured campaigns and closes zero-proposal runs;
- scheduled group enqueues capture exact scope and never re-read assignment membership at execution;
- UI tests cover accessible row/header checkboxes, cross-page filtered tri-state selection, retained
  hidden selections, global clear, explicit all/selected modes and ineligible reasons;
- polling tests cover queued, retry, running, succeeded, failed, visibility pause, abort and bounded
  observation deadline without overlapping fetches;
- Playwright proves selection over more than 25 campaigns, immutable stored scope, unchanged persistent
  assignments and visible terminal transition without manual reload;
- static and runtime blast-radius proofs show no Ads API import/call, shared edit, hosted migration,
  deploy, worker activation, export or apply.

## Acceptance checks

- [x] Architecture and work-package contract committed separately before implementation.
- [x] Focused migration, DB, worker, web and Playwright tests pass.
- [x] Disposable PostgreSQL migration, concurrency and immutable-scope proofs pass serially.
- [x] High correctness and Extra-High adversarial reviews find no blocker, high or medium defect.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm hygiene` pass.
- [x] Exact-head pull-request CI and exact-main CI pass both jobs.
- [x] The source package performed no hosted migration, deployment, service, provider or Amazon
      action and preserved the separate-authorization boundary.
- [ ] Hosted migration apply and deployment each have exact action-specific authorization and
      pre/postflight evidence.
- [ ] Live cutover evidence uses `docs/deploy/wp-195-recommendation-cutover.sql`; no pre-WP-195
      consumer overlaps scoped enqueue, and any rollback destination is WP-195-compatible unless
      enqueue is blocked and both legacy/scoped active counts are zero.
- [x] Handover and status are updated only after reviewed merge and exact-main CI.

## External gates

Merging WP-195 authorizes no external action. Hosted apply requires an exact ordered review because
production currently ends at `20260901010000` while WP-187, WP-192 and WP-194 precede this source
migration. Web deployment requires the exact merged revision and hosted schema. The four-type Evo
report worker does not claim `recommendations.run`; a separate source package must first design and
revision-prove a WP-195-compatible recommendation claimant and exclusive handoff. Its staging and
activation require distinct exact authorizations plus proof that no legacy queued/running
recommendation job remains, retirement of every pre-WP-195 recommendation consumer, and exclusive
health before the new web POST is exposed. Once any scoped job has been enqueued, rollback is limited
to a WP-195-compatible revision unless enqueue is blocked, the compatible consumer is stopped, and
the read-only cutover query proves zero legacy and zero scoped active jobs. Amazon mutation remains
locked behind the separate parity and write-activation program gates.
