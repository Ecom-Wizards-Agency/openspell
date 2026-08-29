# WP-81 — Current release status reconciliation

## Goal

Replace stale release claims with evidence from the exact current main tree, hosted CI, the
production web deployment, the normal shared Chrome session and the MCP runtime boundary.

## Boundary

- Documentation only. No application, package, migration, seed or deployment configuration changes.
- No production/shared database write and no Amazon API call.
- No secret, profile roster, tenant strategy value or private reference material enters Git.

## Verified evidence

- `origin/main` implementation revision: `48b9625`.
- WP-80 pull-request gate: typecheck/lint/test/hygiene passed in 5m33s and serial Playwright passed
  in 12m42s.
- Exact merge-main CI run `33248703627` completed successfully at `48b9625`.
- Production web deployment `dpl_6Y9nvFBgELuGFca9DLXRNPzSnvXH` is ready, owns the custom domain and
  returns HTTP 200 from `/login`.
- The normal shared Chrome session loads the production login route without console errors. A
  direct dashboard request redirects to login, so authenticated final-revision QA is not claimed.
- The public MCP health endpoint returns Cloudflare HTTP 530. Its local container returns
  ready/HTTP 200 at revision `677dbf8`; restoration and both-client retesting remain gated on tunnel
  credential rotation.
- WP-79 supplies the repository-side SP-API profile binding, Vault custody, LWA refresh and weekly
  scheduling path. No hosted migration or tenant binding was applied in this package.
- Official Amazon evidence supports an SB ads report and v4 ad identity, but the exact current
  ad-to-creative-to-Asset-ID response path and accepted video metric columns remain unproven. The
  next safe action is a non-persisting read-only contract probe, not guessed production attribution.

## Acceptance

- [x] Status points to the exact current implementation revision.
- [x] Web deployment and anonymous browser evidence are recorded separately from authenticated QA.
- [x] Historical MCP acceptance evidence is separated from current public availability.
- [x] SQP repository completion is separated from hosted configuration and live parity.
- [x] Remaining migration, authentication, provider and token-rotation gates are explicit.
- [x] No production/shared migration, seed or Amazon write was executed.
