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

- Every shipped/missing claim is traceable to current repository source.
- SP, SB, SB Video and Display creation are distinguished.
- Reporting gaps are prioritized without treating PPC as a substitute for SP-API SQP.
- The implementation order preserves worker-only credentials, immutable approval, counted results,
  observation and conflict-safe reversion.
- Public-repository hygiene passes.
