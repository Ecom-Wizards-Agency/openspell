# WP-27 — Ads API: suggested-bid read + SB v4 media/creative endpoints

**Owner:** Codex (high effort; Opus fallback) · **Phase:** v2 · **Depends on:** WP-02, WP-25 (merged)

Two isolated `packages/ads-api` extensions. Pure client code, recorded-fixture tests, no DB, no
browser, NO new dependencies (reuse `src/__fixtures__/server.ts`). Unblocks the bid-corridor
charts (WP-28) and Creative Hub.

## Scope (packages/ads-api ONLY)

1. **Suggested-bid read**: add the Amazon Ads suggested-bid / bid-recommendation endpoint(s) for
   SP keywords and product targets — returns per-target suggested bid (low / median / high /
   suggested). Typed input/output; mirror the read-client conventions in
   `src/{client.ts,endpoints.ts,http.ts}`. This is the daily series the corridor chart plots.
2. **SB v4 media/creative**: implement the endpoints currently stubbed as
   `AdsApiNotImplementedError` in `src/sb-media.ts` (from WP-25) — media upload/describe, creative
   create/update/list for Sponsored Brands v4. Typed; error-mapped like the rest (429/425/partial).
   If any endpoint genuinely can't be modeled without live docs, keep it a typed stub but document
   why in the file.

## Constraints (Codex sandbox-safe)

- No new deps; reuse the existing fixture harness. No DB, no browser.
- Keep the package pure (imports only `@wizard-ads/shared`); purity/grep clean.
- If the sandbox blocks `.git` commits, commit to a branch via a git bundle AND leave the changes
  in the working tree, and report both — the manager will recover them (as with WP-25).

## Acceptance

- Recorded-fixture tests for every new endpoint incl. 429/Retry-After, 425, partial-failure.
  `items+errors===submitted` where batched.
- `pnpm --filter @wizard-ads/ads-api test` green.
- Branch `wp-27-ads-api-suggested-sb`. Report per endpoint added + any that stayed stubbed.
