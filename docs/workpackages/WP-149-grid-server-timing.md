# WP-149 — Grid server timing evidence

## Outcome

Expose closed, identifier-free `Server-Timing` spans on successful authenticated Grid row
responses. This separates fixed request overhead from profile lookup, fact aggregation, and
serialization before the next performance change is chosen.

## Spans

- `actor`: Supabase session validation and active-organization resolution;
- `role`: tenant membership and role lookup;
- `profile`: server-owned profile and currency lookup;
- `rows`: selected entity aggregation and mapping;
- `serialize`: bounded JSON serialization;
- `total`: complete measured route time.

Only span names and millisecond durations are emitted. The API cannot attach tenant ids, profile
ids, labels, query text, errors, credentials, or row content to the header.

## Acceptance

- Successful responses contain every fixed span exactly once and in execution order.
- The header contains no user-controlled input or tenant identity.
- Cache, tenancy, exact-count, byte-budget, abort, retry, and truncation behavior remain unchanged.
- Invalid or unauthorized requests retain their existing status and generic response contract.
- The package performs no Amazon call or write and changes no database schema.
