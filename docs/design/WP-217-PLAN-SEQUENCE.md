# WP-217 keyword plan sequence

Status: shared contracts committed; controlled source producer, recording and inverse
integration verified locally. Delegated admission, MCP tools and deployment remain pending.

## Caller usage

The MCP caller submits one `keyword_proposals` request containing ordered bid rows. Its
preview preserves that sequence. An inverse preview preserves the original operation's
sequence and identifies every original action. Neither caller chooses a sorting option.
Both use the existing preview, approval, execution and Time Machine operations.

## Ground and synthesis

The existing plan v1 parser sorts with JavaScript `localeCompare`. The new independently
callable SQL producer cannot reproduce that runtime-dependent comparator. A raw two-row
request with a reordered, freshly hashed plan could commit and then fail the shared reader.
Source arrays already record request order, so new keyword plans use that immutable order.

Three independent candidates evaluated a nested source-order marker, intrinsic UUID order,
and a bounded plan v2 versus a one-row restriction. The selected design uses
`openspell.sp-write-plan.v2`, with the same field names and keyword bid actions, and defines
its array as a source sequence. V1 retains its existing ordering and fingerprint prefix.
No saved artifact is converted. Historical forward, inverse and mixed-route hashes were
captured before the contract edit and are pinned in tests.

UUID order is portable but makes the review and inverse sequences arbitrary. A marker in
v1 can preserve old bytes, but changes the meaning of the same version and still requires
new readers. Restricting requests to one row fails the batch workflow; silently splitting
requests would complicate approval, capacity and partial outcomes. V2 exposes the necessary
protocol distinction without adding an operator setting or a second worker.

## Contract and boundaries

- `SpWritePlan` recognizes exactly v1 and v2. V2 supports one positive canonical
  `keyword.bid` change per action, at most eight integer and four fractional digits,
  with no no-op, duplicate entity, action or source. Existing count, scope and time checks
  remain. Its fingerprint binds the version and entire ordered array.
  The three v2 plan timestamps accept UTC instants with at most six fractional digits,
  preserving the existing database formatter. SQL compares their millisecond-truncated
  values to match JavaScript validity checks; longer fractions refuse before PostgreSQL
  can round them. Historical v1 timestamp acceptance is unchanged.
- `verifyMcpWritePreviewEvidenceArtifacts` requires v2 for the new unreleased MCP source.
  Each action position must match that position's immutable proposal row, including the
  apply-row identity, keyword and before/after values. The standalone parser cannot prove
  an external source relation; the evidence verifier supplies it.
- `verifySpWriteInversePair` requires the same plan version on both sides. V2 requires
  each inverse action position to reference the corresponding original action, in addition
  to all existing exact-swap checks. V1's identity-based pairing remains unchanged.
- SQL must independently enforce canonical v2 bytes and the forward source sequence at the
  controlled producer and generic recorder. A v2 forward requires the exact private source
  plan identity. A v2 inverse requires its immutable v2 parent and exact positional pairing;
  a raw v1 inverse may not downgrade a v2 parent. Recording failure must roll back all rows.
- Inverse construction maps v2 actions in place; legacy construction still sorts. Current
  human authority can approve an inverse after the source key is revoked. Execution
  delegation and key liveness remain separate authority checks.

The additive SQL changes belong to the unmerged
`20260906020000_mcp_bid_proposal_sources.sql`, outside WP-207. Shared contracts commit
before dependent implementations. No historical migration or Claude-owned file changes.
Compatible readers and schema must be deployed before this producer is enabled.

## Verification and phase position

Ground and three-candidate sketch are complete. The operator authorized autonomous
implementation, so this bounded decision does not require another checkpoint. Implement
is active. The locale-order assumption for new MCP plans is discarded; v1 is preserved.

Local evidence covers old byte hashes, valid two-row source sequence, rehashed order-only
tampering at raw SQL and direct-record boundaries, version downgrade refusal, all 500 source
rows at the supported maximum, and a two-row forward/inverse cycle with a fake provider after
key revocation. Original and inverse each retain their Time Machine row entries and links.
The final independent SQL run checked 67 outcomes, including refusal of a submillisecond
validity window. No live Amazon write or hosted migration is covered by these checks.
