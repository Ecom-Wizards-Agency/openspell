# WP-195 architecture: immutable campaign-scoped preview batches

Status: selected for implementation on 2026-09-02.

Base: `origin/main` at `326fd09c315d1737cbbeba87b54c81d1544b922a`.

## Usage

The Campaign Optimizer owns transient preview selection. The optimization-group page continues to
own persistent campaign-to-policy assignment; its checkboxes are not reused.

```text
Campaigns
  [–]  select all 17 campaigns matching the current filters
  [x]  Campaign A
  [ ]  Campaign B
  ...

Preview scope
  ( ) All eligible campaigns (42)
  (x) Selected campaigns (17)       Clear selected

  Run preview · 17 selected
```

The header checkbox operates on every eligible row matching the current search, group and state
filters across all pages. Selections outside the current page or filter remain selected. `All`
always means the server-resolved eligible profile roster at enqueue time; UI filters never redefine
it.

One click creates one user-visible preview batch. The server atomically partitions its campaigns by
their current optimization group, with one additional unassigned partition when needed. Each child
recommendation run retains the existing one-policy runner. The UI polls the parent and presents the
aggregate state plus links to every child run that produced reviewable recommendations.

This remains a read-only preview. It proposes database recommendations and performs no Amazon Ads
mutation, export or apply.

## Decision summary

WP-195 adds transient row selection, a small preview POST/status API and bounded client polling. The
enqueue transaction captures exact sorted campaign ids, counts, fingerprints, group snapshots and
the resolved strategy before it inserts any queue job. The worker verifies and reads this persisted
scope by run id. It never reconstructs a scoped run from live campaign assignments.

The existing `RecommendationsRunJob` stays unchanged: its `runId` points to the authoritative
database scope. HTTP request and response shapes remain local to the web application; database and
runner method shapes remain implementation APIs in their owning packages. No shared contract edit is
needed.

The source migration, hosted apply, web deploy, worker release and worker activation remain separate
gates. Merging this package authorizes none of them.

## Grounded problem

The present optimizer has two distinct failures:

- `/optimizer` contains no transient selection. Its only run action either queues a group-null
  profile run or sends the operator to the persistent group editor.
- both the profile and group run paths refresh once immediately after enqueue. They never poll, so a
  rendered `queued` or `running` state remains stale until manual navigation.

There is also a deeper custody bug. A group run snapshots its policy, but `loadInputs` filters facts
through live `campaign_optimization_assignments` at worker execution time. Moving a campaign after
enqueue therefore changes the scope of an already queued run. A profile-level selected run would be
worse: the current runner owns one group snapshot, so arbitrary cross-group campaigns would be
evaluated under one legacy strategy rather than their assigned policies.

## Architecture candidates

### Candidate A: one profile run with selected campaign ids

Persist the selected ids on one recommendation run and teach the engine to resolve a different group
policy per target.

This produces the simplest polling object, but it replaces the proven one-group evaluation contract,
must snapshot a complete campaign-to-policy map, and must apply group safety independently inside one
run. Adding ids alone would silently use the wrong policy.

Decision: rejected for this slice.

### Candidate B: require one group per selection

Allow row selection only within one optimization group and enqueue the existing group run.

This is the smallest worker change, but it does not implement arbitrary selected or all campaigns in
the AdLabs interaction. Cross-group work would become several non-atomic clicks with no coherent
idempotency or aggregate status.

Decision: retained only for the existing group-manager manual preview, rejected for the primary UI.

### Candidate C: one parent batch with group-partitioned child runs

Resolve the selected/all roster once, partition it under the profile lock, and insert one child run
per group plus one unassigned child. Persist exact membership on every child and expose the parent as
the polling object.

This preserves group policy and safety while giving the operator one action. It reuses the current
runner and shared queue payload rather than introducing a second optimization engine.

Decision: selected.

## Eligibility and selection contract

The selectable set is deliberately narrower than the visible campaign table:

- the campaign belongs to the authenticated organization and selected profile;
- it is not deleted and its state is `enabled`;
- its ad product is Sponsored Products, the product currently backed by numeric target-level bid
  proposals;
- when assigned, its optimization group is enabled.

Sponsored Brands, Sponsored Display, paused, archived, deleted and disabled-group campaigns remain
visible with an explicit reason that they cannot be included. The server enforces the same predicate.
No disabled checkbox is a security boundary.

Selected mode requires 1 through 10,000 unique, non-empty campaign ids and a request body no larger
than 512 KiB. Duplicate, empty, foreign, stale, ineligible or oversized input rejects the entire
request. It is never truncated and invalid rows are never silently dropped. All mode accepts no ids
and resolves the complete eligible roster on the server. A zero-campaign all request is refused
without an artifact.

If a captured campaign later pauses or is tombstoned, its identity remains in the immutable scope and
execution records the ordinary inactive/missing-evidence skip. No newly eligible campaign replaces
it.

## Web-local API

The browser submits a UUID idempotency key generated for that click. An uncertain network response is
retried with the same key; a new operator action gets a new key.

```ts
type PreviewRequest = {
  profileId: string;
  clientRequestId: string;
  scope:
    | { mode: 'all' }
    | { mode: 'selected'; campaignIds: string[] };
};

type PreviewAccepted = {
  batchId: string;
  status: 'queued';
  scope: { mode: 'all' | 'selected'; campaignCount: number; fingerprint: string };
  childCount: number;
};
```

`POST /api/optimizer/runs` derives actor, organization and capability from server context. Neither is
accepted from the body. A repeated `(org, profile, clientRequestId)` with the same canonical request
fingerprint returns the original batch. Reusing the key for different input is a conflict.

`GET /api/optimizer/runs/:batchId` is tenant scoped and returns only bounded operational data:

```ts
type PreviewStatus = {
  batchId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  campaignCount: number;
  proposalsCount: number;
  children: Array<{
    runId: string;
    groupName: string | null;
    status: 'queued' | 'running' | 'succeeded' | 'failed';
    campaignCount: number;
    proposalsCount: number;
  }>;
};
```

Queue status is authoritative for retry state. A child whose recommendation row says `failed` while
its queue job is queued for retry remains queued. A child succeeds only when both run and job
succeeded; a dead or terminal failed job fails it. Any failed child makes the batch failed while the
response preserves every child state rather than hiding partial completion.

## Persistence

The additive migration introduces:

- `recommendation_preview_batches`: tenant/profile identity, UUID client request id, selection mode,
  canonical request fingerprint, exact effective-scope count/fingerprint, exact child count, actor
  and creation time;
- nullable batch/scope/job metadata on `recommendation_runs` for new scoped work while historical
  rows remain valid legacy evidence;
- `recommendation_run_campaigns`: immutable tenant/profile/batch/run/campaign membership.

Database invariants include:

1. composite tenant/profile foreign keys on batches, runs and scope rows;
2. scope version, positive count and 64-hex fingerprint are all null for legacy rows or all valid for
   scoped rows;
3. one child per batch/group partition, including at most one null unassigned partition;
4. one campaign per child and one occurrence across the complete batch;
5. non-empty campaign ids and positive bounded batch/child counts;
6. service-only insert/update/delete with tenant-scoped authenticated reads;
7. one client request id per tenant/profile and no key rebinding;
8. one exact queue-job identity stored on each new child run.

Cross-row count and digest closure cannot be expressed as a static check constraint. Enqueue asserts it
after insertion, and worker start independently recounts and rehashes before changing the run to
`running`.

Fingerprints use SHA-256 over domain-separated, versioned canonical text with ids sorted by bytewise
order. Request fingerprints bind mode and the offered selected ids. Effective fingerprints bind the
resolved profile, batch or run scope. They are audit identities, not secrets.

## Atomic enqueue

Manual enqueue follows the existing profile-first lock order:

1. validate the bounded request and lock the scoped advertising profile;
2. detect an idempotent replay or key conflict;
3. read the exact eligible campaign roster and current assignments;
4. for selected mode, prove offered count equals unique count equals eligible resolved count;
5. resolve and snapshot tenant/profile strategy and every referenced group;
6. preflight disabled groups, active partition conflicts and group anti-compounding safety;
7. sort, partition and fingerprint the effective roster;
8. insert one parent, every child run, every scope row and every queue job;
9. read back counts and fingerprints and commit only when the complete union closes.

One unsafe or unverifiable partition aborts the transaction. There is no partial batch. Profile
locking serializes group assignment saves and manual/scheduled enqueues, so a concurrent group move is
captured entirely before or entirely after the request.

Scheduled group runs do not need a user-visible parent, but they use the same immutable child-scope
capture and strategy/group snapshot. An empty scheduled group advances according to the existing
schedule policy without enqueueing a zero-scope job. Every newly enqueued recommendation job is
scoped; deployment must prove no legacy queued or running recommendation jobs before the new worker
contract is activated.

The compatibility boundary is asymmetric. A pre-WP-195 worker understands the unchanged job payload,
but it does not understand immutable scope rows or enqueue-time policy snapshots. Cutover therefore
applies the hosted migration, blocks recommendation enqueue, proves `legacy_active = 0`, retires every
pre-WP-195 recommendation consumer (including a cron overlap), activates a WP-195-compatible worker,
and only then exposes the new POST route. `docs/deploy/wp-195-recommendation-cutover.sql` is the
read-only evidence query. After the first scoped job exists, a pre-WP-195 revision is not a valid live
rollback destination unless enqueue is blocked, the compatible consumer is stopped, and the same query
proves both `legacy_active = 0` and `scoped_active = 0`. Normal rollback must remain within
WP-195-compatible revisions.

## Worker lifecycle

`startRun` locks the run, loads its sorted scope rows, verifies version/count/fingerprint and verifies
the stored strategy and group snapshots before setting `running`. A mismatch is a permanent scoped-run
integrity failure and writes no recommendation.

`loadInputs` joins target and campaign facts to `recommendation_run_campaigns` by tenant, profile and
run. It never consults live assignment rows for scoped work. The runner uses the enqueue-time resolved
strategy plus the child group's enqueue-time snapshot. The job payload continues to carry only run,
tenant, profile, lookback and optional group ids.

Legacy rows remain decodable for historical display. No new path may mint an unscoped run. Activation
does not reinterpret or adopt an old queued run.

## UI and polling

Native checkboxes provide row labels and a tri-state header. The scope controls are a fieldset with an
explicit legend. Selecting a row or filtered header chooses Selected mode. Zero selected disables that
mode and the action rather than falling back to All. `Clear selected` clears hidden selections too.
Changing profile resets selection; period, page, filter and status refresh do not.

The client shows resolved counts returned by the server, disables duplicate submission while the batch
is active, and announces selection and run state through a polite live region. A recursive non-
overlapping poll backs off from one to two to five seconds, aborts on unmount/profile change, pauses
while the document is hidden and stops at a bounded ten-minute observation deadline with an honest
`Still running` message. It never claims success optimistically.

Terminal state causes one router refresh. Successful children link to their existing immutable run
review pages. Failure shows a sanitized retryable operator message; details remain in the queue/run
ledger.

## Proof plan

- UI unit tests: native/tri-state semantics, more-than-one-page filtered selection, hidden selection
  retention, global clear, profile reset, all versus selected, disabled reasons, viewer gating,
  enqueue error and queued/running/succeeded/failed/deadline polling;
- database/worker tests: two groups plus unassigned produce one parent and three exact children;
  selected/all counts and digests close; duplicate, empty, foreign, stale and oversized requests write
  zero artifacts; identical concurrent keys produce one batch; changed key input conflicts;
- race tests: group move versus enqueue yields one complete before/after snapshot; assignment, strategy,
  pause and deletion after enqueue cannot substitute membership or policy;
- integrity tests: missing/extra/reassigned scope rows or altered fingerprints permanently fail before
  proposals; only captured campaigns can produce proposals; zero-proposal runs still close correctly;
- scheduler tests: scheduled group membership is captured and later assignment edits cannot change it;
- API tests: tenant scoping, role enforcement, bounded bodies and truthful aggregate retry/terminal state;
- Playwright: at least 56 campaigns, filtered selection across pages, clear/select subset, enqueue, direct
  persisted-scope proof, unchanged assignment rows and visible status transition without manual reload;
- blast radius: frozen shared package unchanged, web still imports no Ads client, no Amazon mutation call,
  one new source-only migration and no deployment or hosted apply.
