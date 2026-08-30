# WP-123 — Advertising API capability map

## Outcome

Document the difference between Amazon platform availability, a typed API client, a reachable
worker/web workflow, and live verification. This prevents client-only methods or fixture coverage
from being presented as working operator features.

## Scope

- `docs/ADS-API-CAPABILITIES.md`
- this brief

No runtime code, migration, deployment, credential access, browser mutation, or Amazon API call is
part of this package.

## Acceptance

- Every implemented/missing claim is traceable to the revision-stamped repository source.
- Amazon platform claims name the exact Unified, legacy or product-specific dialect and are
  traceable to revision-pinned primary Amazon specifications or current lifecycle guidance.
- SP, SB, SB Video and Display creation are distinguished.
- Current Asset Library upload/registration is separated from deprecated `/media/upload` and legacy
  `/media/describe` original-video retrieval, and asset response `version`, registration
  `versionId`, Unified input `assetVersion`, eligibility, moderation and delivery states are not
  conflated.
- Reporting and Marketing Stream availability includes history, beta, AWS subscription, the
  SQS-only confirmation step, and raw-ingestion caveats.
- Reporting gaps are prioritized without treating PPC as a substitute for SP-API SQP.
- The implementation order preserves server-side credential custody, immutable approval, counted
  results, OpenSpell-side deduplication, observation and conflict-safe reversion without assuming an
  Amazon idempotency key.
- The credential boundary documents both server-side `apps/web` paths: the OAuth callback and the
  Vercel cron route that invokes the worker Ads integration with LWA and Vault-backed credentials.
  Neither exposes tokens to browser code, and MCP receives no Amazon credentials.
- Public-repository hygiene passes.
