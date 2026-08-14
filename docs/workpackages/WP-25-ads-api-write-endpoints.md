# WP-25 — Ads API write-endpoint layer

**Owner:** Codex (high effort) · **Phase:** v2 prerequisite · **Depends on:** WP-02 (merged) ·
**Unblocks:** WP-12, WP-14b, off-Amazon control, Creative Hub

`packages/ads-api` is currently read-only. Add the create/update/archive endpoints every write
feature needs. Pure client code — no DB, no browser — mirroring the existing read client.

## Scope

Add to `packages/ads-api` (own this package only):
- **Sponsored Products writes**: create/update/archive for campaigns, ad groups, keywords,
  product targets, negative keywords, negative targets, product ads. Match Amazon Ads API v3 SP
  request/response shapes (partial-update semantics, batched operations, per-item success/error
  results). Placement bid-adjustment updates on campaigns (incl. the off-Amazon serving attribute
  seam — bulk column AQ equivalent).
- Typed inputs/outputs; reuse `EntityRow`/shared types where they fit, add local request types
  where the API shape differs from the mirror row.
- Error mapping consistent with the read client: 429→throttle (with Retry-After), 425 duplicate,
  per-item partial failures surfaced (not swallowed), 4xx non-retryable.
- SB v4 media/creative endpoints: **stub the interface only** (typed, throwing "not implemented")
  so Creative Hub can build against it later; do not implement v4 media now.

## Constraints (Codex sandbox-safe)

- **Do NOT add new dependencies** (no msw). Reuse the existing recorded-fixture fetch-mock harness
  already in this package (`src/__fixtures__/server.ts` — the same pattern WP-02 used instead of
  msw). No npm-registry install needed.
- No database, no browser, no filesystem beyond the package. Fixture tests only.
- Read `packages/ads-api/src/{client.ts,endpoints.ts,http.ts,errors.ts,exports.ts}` first and
  mirror their conventions exactly (endpoint tables, header builders, retry via `httpRequest`).
- Read `~/os/amazon-agent/tools/amazon-campaign-builder/references/bulksheets-2.0-reference.md`
  for SP field/operation semantics (partial update, archive cascade, portfolio re-inclusion).

## Acceptance

- Recorded-fixture tests for every new endpoint incl. 429/Retry-After, 425, partial-failure
  batches (some items ok, some error). `items + errors === submitted` asserted per batch.
- Purity holds: `packages/ads-api` still imports only `@wizard-ads/shared`; grep clean.
- `pnpm --filter @wizard-ads/ads-api test` green; `pnpm check` green.
- Live smoke: do NOT run (needs operator creds + would mutate a real account). Instead add the
  write calls to the existing smoke script behind an explicit `--writes` flag that is OFF by
  default and documented as operator-only against a sandbox campaign.
- Branch `wp-25-ads-api-writes`. Report per acceptance check; list every endpoint added.
