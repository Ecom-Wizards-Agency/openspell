# WP-51 design — test backlog and recommendation preconditions

## Problem

WP-51 has two different integration seams. The vetted experiment backlog is already
ported inline in `packages/core/src/recommendations.ts`, but it needs a stable,
independently parity-tested home that the experiments surface can call. Stock and rank
rules belong at the bid-engine boundary, where every proposed bid passes, while the
database sources that feed those rules belong in the worker. `packages/shared` is
frozen, so operator-visible precondition notes must travel beside the shared
`Recommendation` and be persisted through the existing audit-log note seam rather than
widening `RecommendationInputs`.

## Usage (caller's view)

The weekly qualitative engine and the experiments page both call the same selector:

```ts
import { selectTests } from '@wizard-ads/core';

const proposedTests = selectTests(new Set([
  'goal:scale',
  'rank_present',
  'discovery_present',
]));
```

The worker supplies pre-resolved, tri-state evidence to the bid engine:

```ts
const outcome = proposeBid({
  ...request,
  stock: { status: 'unknown', asins: ['B0SYNTHETIC'] },
  organicRank: { status: 'known', current: 8, previous: 12 },
});
```

An out-of-stock input returns a blocked outcome. Unknown stock fails open, and a
proposal carries a `stock_unknown` note. A cut with improving organic rank is
suppressed. A keyword proposal without rank data carries a `rank_unknown` note.

The experiments page receives the selected `TestIdea[]` as serializable props and
refreshes them with the existing `/api/experiments` read when the profile changes.
Nothing in the proposed-tests section creates a stored experiment.

## Shape

`packages/core/src/experiments/backlog.ts` owns `TestCandidate`, `TestIdea`,
`DEFAULT_TEST_BACKLOG`, and `selectTests`. It exposes one deep operation: requirement
alternatives, default fallbacks, source/status mapping, and the empty-list rule stay
behind a single function, per boundary discipline. `recommendations.ts` continues to
derive weekly tags and delegates selection.

`BidRequest` accepts `StockSignal` and `OrganicRankSignal`. Both are discriminated
unions, so unknown evidence cannot masquerade as a negative fact. `proposeBid` invokes
an internal precondition check; callers never coordinate formula selection with policy.
`BidOutcome` gains a blocked case and structured `BidPreconditionNote[]` on outcomes
that carry a recommendation. Rank/SKW cuts are always suppressed, regardless of tenant
configuration, and any improving keyword rank suppresses a cut. This concentrates
policy behind the existing bid-engine surface rather than creating a pass-through
wrapper.

The worker owns storage adaptation. It resolves advertised ASINs from the product-ad
mirror and organic-rank movement from `rank_observations`. The current economics schema
contains no modeled stock field, and its raw `details` document has no validated stock
contract, so the worker supplies `unknown` instead of guessing at provider JSON. Notes
on emitted proposals are written to `audit_log`, the repository's existing
recommendation-note store, and are count-asserted. Core remains pure and shared remains
unchanged.

The web data helper loads only org/profile-scoped goal and active campaign names,
turns those into the backlog's goal/category-presence tags with core's campaign
classifier, and calls `selectTests`. The server page and route handler share that helper.

## Synthesis decision

The base is the smallest-public-surface candidate: extend `proposeBid` with typed
evidence and make it enforce all preconditions itself. The isolation candidate's useful
part—small pure helpers for stock/rank decisions—stays private inside the bidding
module. Its public `check`-then-`propose` workflow was rejected because callers would
need to know whether a selected formula is a cut, leaking engine policy and creating a
temporal call sequence. A `proposeEligibleBid` wrapper was also rejected as a
pass-through layer that would leave the original unsafe entry point callable.

## Tradeoffs accepted

- We accept fail-open stock notes on every current live proposal in exchange for never
  interpreting opaque provider JSON as reliable inventory evidence.
- We accept worker-local annotated recommendations in exchange for preserving the
  frozen shared recommendation contract.
- We accept goal/category-presence proposals on `/experiments` in exchange for keeping
  account-performance interpretation in the weekly recommendation engine rather than
  duplicating it in the web tier.
- We accept a blocked bid outcome with no fabricated recommendation row in exchange for
  making out-of-stock a true precondition rather than a zero-value proposal.

## Alternatives considered

- A public `checkBidPreconditions` followed by `proposeBid` exposed formula direction
  and required ordered caller coordination; it hid less complexity behind more API.
- A wrapper around the unchanged bid engine left two public paths, one of which could
  bypass stock and rank doctrine; this was not a viable safety boundary.
- Adding note fields to `packages/shared` would make persistence simpler, but violates
  the contract freeze and forces unrelated packages to absorb a WP-51-only change.

## Open questions and risks

- Which synced provider field will become the authoritative in-stock/out-of-stock fact?
  Until a validated contract lands, the only honest production value is `unknown`.
- When one ad group advertises multiple ASINs, should one out-of-stock child block the
  shared target or should the campaign be split first? The safe initial rule is that any
  known out-of-stock associated ASIN blocks the target.

## Next implementation step

Extract the backlog module and pin it with Python-generated selector goldens before
changing bid outcomes or worker persistence.
