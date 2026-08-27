# WP-48 bid-history design

## Problem

The existing bid corridor is loaded on `/optimizer` as a campaign-level card with a raw-ID
chooser, while the evidence and the operator workflow are target-level. WP-48 must move the
same stored series behind row-level QA affordances in both the targets grid and optimizer,
combine it with target labels and target-grain fact totals without crossing the org boundary,
and add the latest corridor values to every target grid row without an N+1 query. The shared
contract, schema, and migrations are frozen.

## Usage (caller's view)

The grid opens one target's history from its existing target row:

```tsx
<DataGrid
  onRowClick={(row) => setTargetId(String(row.dimensions.target_id))}
/>
{targetId === null ? null : (
  <BidHistoryModal
    profileId={profileId}
    targetId={targetId}
    window={period}
    currencyCode={currencyCode}
    onClose={() => setTargetId(null)}
  />
)}
```

An eligible optimizer proposal uses the same modal and passes `ProposalView.entityId`.
The modal makes one request:

```text
GET /api/bid-history?profile=<uuid>&target=<amazon-target-id>&from=YYYY-MM-DD&to=YYYY-MM-DD
```

The route returns one UI-ready payload containing target identity, selected-window base totals,
and daily corridor points. The target grid separately enriches its already-loaded rows with one
batched helper call:

```ts
const latest = await readLatestBidSeriesByTargetIds(handle, {
  orgId,
  profileId,
  targetIds: rows.map((row) => row.target_id),
});
```

## Shape

```ts
interface BidHistoryTarget {
  targetId: string;
  targeting: string;
  matchType: string | null;
  adProduct: string;
  targetKind: string;
  campaignId: string;
  campaignName: string;
}

interface BidHistoryPayload {
  target: BidHistoryTarget;
  window: { from: string; to: string };
  totals: BaseTotals;
  points: BidCorridorPoint[];
}

async function loadBidHistory(
  handle: Pick<DbHandle, 'sql'>,
  scope: { orgId: string; profileId: string; targetId: string; from: string; to: string },
): Promise<BidHistoryPayload | null>;

async function readLatestBidSeriesByTargetIds(
  handle: Pick<DbHandle, 'sql'>,
  scope: { orgId: string; profileId: string; targetIds: readonly string[] },
): Promise<LatestBidSeries[]>;

function aggregateBidCorridorPoints(
  points: readonly BidCorridorPoint[],
  granularity: 'D' | 'W' | 'M',
): BidCorridorPoint[];
```

The API route owns authentication, membership, input validation, and profile ownership. The
bid-corridor loader owns the SQL-to-domain adaptation and always includes `org_id` in each
predicate. The modal owns loading, error, focus, and rendering state. `BidCorridorChart` owns
the D/W/M projection: weekly/monthly low is the minimum, high the maximum, and median, bid, CPC,
and max CPC are means. The DB helper hides `distinct on`, date ordering, and numeric decoding
behind one batched call. Per boundary-discipline, validation happens at the request edge and
typed payloads are trusted inside. The public surface is one modal, one combined loader, and one
batch helper; callers do not coordinate label, fact, and series reads themselves.

The grid stores latest median/low/high/max-CPC/difference as numeric dimensions, so its existing
sort and filter pipeline remains the single implementation. The suggested-bid column opts into
one two-line renderer while retaining the median as its sortable value. Campaign category is
derived once from the joined campaign name with `classifyCampaignCategory`; it is never stored.
The sorted-header aggregate reads the existing `GridModel.totalsRow`, so additive and derived
metric totals cannot diverge from the pinned totals row.

## Synthesis decision

The smallest-surface candidate—a combined history endpoint and one modal—became the base because
it hides three database reads behind one actor-scoped operation. A testability-first candidate
split target lookup, facts, and series into separate client calls; its pure bucketing idea was
kept, but its public orchestration was rejected as temporal decomposition. A grid-centric
candidate joined the latest series directly into the large aggregate SQL; its one-round-trip
appeal was rejected because it duplicated the latest-row rule in the web layer and made the
requested DB helper ceremonial. The synthesis keeps the batch helper as the one owner of that
rule and accepts one additional query after the target aggregate.

## Tradeoffs accepted

- We accept a second target-grid query in exchange for one reusable latest-row rule and no N+1.
- We accept a web-local API payload type in exchange for respecting the frozen shared contract;
  it is a screen-specific shape, not a cross-package domain contract.
- We accept no comparison-period deltas in the modal KPI row in exchange for matching the WP-48
  contract, which asks for same-window target KPIs only.
- We accept dropping modifier-component detail in weekly/monthly buckets in exchange for not
  presenting averaged modifiers as if they were a real day's composition.

## Alternatives considered

- Three client endpoints (identity, facts, corridor) exposed loading order and partial-failure
  policy to every attach point, so it was a shallow public interface.
- A server-rendered modal per row would serialize every series up front and destroy the explicit
  asynchronous drill-down state.
- A lateral latest-series join inside `loadTargets` hid one round trip but leaked the latest-row
  invariant into the web aggregate and failed the brief's reusable-query-helper requirement.

## Open questions and risks

- Could target IDs ever be reused across campaigns inside one profile? Existing reads and the
  current corridor model treat `target_id` as the drill-down key, so WP-48 preserves that
  invariant rather than inventing a wider client key.
- Should comparison-period KPI deltas return later? The response keeps base totals as a named
  field, so adding an optional comparison total would not change the series or target identity.

## Next implementation step

Add and test the batched latest-series helper, then enrich `loadTargets` through that boundary.
