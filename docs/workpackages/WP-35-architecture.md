# WP-35 architecture — bug widget, board, and dedup seam

## Problem

WP-35 adds a fast bug-only submission path and a tenant-visible bug board without
creating a second feedback system. The existing feedback API, query module, role
checks, and roadmap vote route remain the system of record. The non-obvious part is
the duplicate relationship: it must be an atomic admin transition, must never reveal
another organisation's items, and must leave a narrow contract for an out-of-band
service-role job without putting AI work in the web request.

## Usage (caller's view)

The root layout mounts one authenticated-only widget. The widget turns its one text
field into the existing feedback wire shape and uses the current route to recover the
selected profile:

```ts
const payload = buildBugWidgetPayload({
  text: 'Export loses its sort\nHappens after filtering by spend.',
  severity: 'high',
  route: '/grid?profile=00000000-0000-4000-8000-000000000001',
  appVersion,
});
await fetch('/api/feedback', { method: 'POST', body: JSON.stringify(payload) });
```

Before submission, the widget performs a debounced tenant-scoped read:

```ts
const similarPath = ['/api', 'feedback', 'similar'].join('/');
const response = await fetch(`${similarPath}?q=${encodeURIComponent(payload.title)}`);
const { items } = await response.json();
```

The bug page requests one board read model. Admin duplicate marking is one operation,
not a caller-coordinated status update followed by a relationship update:

```ts
const board = await listBugBoard(database, { orgId, viewerId });
const item = await markFeedbackDuplicate(database, {
  orgId,
  itemId,
  duplicateOf,
  viewerId,
});
```

## Shape

`FeedbackItemRecord` gains `duplicateOf` and `dedupCheckedAt`, mirroring the additive
migration. `listBugBoard` owns the status mapping (`new`/`triaged` to open,
`planned`/`in_progress` to in progress, `shipped` to fixed) and separates ordinary
declines from duplicates. The client board owns only presentation and nests duplicate
rows beneath their target id.

`findSimilarOpenBugs(handle, { orgId, viewerId, query, limit })` normalises and bounds
the title fragment, applies the organisation predicate and open-bug predicates in the
same SQL statement, and returns ordinary `FeedbackItemRecord` values. The API route
only resolves membership and maps records to the existing UI shape. This keeps tenant
and open-status knowledge behind one interface, per boundary-discipline.

`markFeedbackDuplicate` validates that source and target are distinct items in the
same organisation, then atomically sets `status = 'declined'`, the standard note, and
`duplicate_of`. The HTTP route treats `duplicateOf` as triage and requires the existing
`triageFeedback` capability. The database migration also prevents author updates to
the new operational columns. This interface is deep: callers provide two ids and do
not coordinate relationship, status, note, tenant validation, or read-back.

`buildBugWidgetPayload` is pure and is the only owner of the first-line-title rule.
The component owns browser mechanics (route capture, focus, debounce, toast) but does
not duplicate payload policy. No shared-package contract changes are needed.

The future 24/7 job is deliberately absent. Its database contract is rows where
`dedup_checked_at is null`; after evaluation it sets `dedup_checked_at`, and when it
chooses a duplicate it must make the same declined/note/relationship transition as
the admin operation.

## Synthesis decision

The selected base optimises for the smallest public surface: two dedicated database
operations and one pure payload builder. It incorporates the isolation candidate's
pure board grouping/payload parsing so render and payload rules can be tested without
a server. It rejects a generic `patchFeedback` plus client-side grouping because that
would expose status mapping and atomic duplicate invariants to every caller. It also
rejects a new bug-specific storage/API stack because it would duplicate feedback,
voting, auth, and tracker policy.

The design was screened for shallow modules, information leakage, temporal
decomposition, and pass-through methods. The API handlers remain intentionally thin
authorization/adaptation boundaries; the policy-heavy operations live in the query
and pure UI modules that own their decisions.

## Tradeoffs accepted

- We accept an ILIKE title-fragment search in exchange for a migration-free,
  deterministic pre-submit hint; the later AI job owns semantic matching.
- We accept `planned` bugs appearing in the In progress column in exchange for every
  non-terminal bug having a visible board state.
- We accept UUID entry in the small admin duplicate control in exchange for avoiding a
  second search/selection workflow in this package; visible cards expose the item id.
- We accept a new optional toast action in exchange for preserving the closed-widget
  success state while still linking directly to the created bug.

## Alternatives considered

- A generic feedback patch method lost because it exposes a shallow bag of optional
  fields and makes callers learn which combinations form a valid duplicate transition.
- A separate bugs table and API lost because it hides little while exposing a second
  vote, auth, tracker, and lifecycle interface.
- Client-side filtering of the general feedback endpoint lost because it exposes
  tenant-sized result sets and duplicates the definition of an open bug.

## Open questions and risks

- Could short or generic title fragments produce noisy similar results? The widget
  waits for a bounded minimum length and caps results; semantic precision belongs to
  the later job.
- Could a duplicate target later be deleted? The foreign key uses `on delete set null`,
  leaving the declined item and its explanatory note intact.
- Could a target live in another organisation? Both the query operation and migration
  enforcement reject that relationship.

## Next implementation step

Add the migration and database record/query operations first, then build the two web
surfaces against those fixed signatures.
