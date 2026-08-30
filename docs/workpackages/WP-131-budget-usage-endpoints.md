# WP-131 — Product-specific budget-usage reads

## Outcome

Use Amazon's product-specific campaign budget-usage endpoints for Sponsored
Products, Sponsored Brands, and Sponsored Display. Treat every response as an
indexed batch result and reject partial or ambiguous evidence.

This is a read-only Ads API package change. It does not add a worker job, a web
route, a database migration, a deployment, or an Amazon mutation.

## Verified provider contract

Primary evidence is Amazon's official Ads API Postman collection at pinned
commit `5c1c432c3dbe676a571780aa0c4d0217659a5f3a`:

- SP: `POST /sp/campaigns/budget/usage`, with
  `Accept: application/vnd.spcampaignbudgetusage.v1+json`;
- SB: `POST /sb/campaigns/budget/usage`;
- SD: `POST /sd/campaigns/budget/usage`;
- request body: `{ "campaignIds": [...] }`;
- response: top-level `success` and `error` arrays whose rows carry the input
  `index`; success rows also carry campaign id, budget, usage percentage, and
  usage update timestamp.

Pinned source:
<https://github.com/amzn/ads-advanced-tools-docs/blob/5c1c432c3dbe676a571780aa0c4d0217659a5f3a/postman/Amazon_Ads_API.postman_collection.json>

The collection's editable SB request example mistakenly repeats the SP path and
media type. Its saved `originalRequest`, the SB migration guide, and the
product-specific response identify `/sb/campaigns/budget/usage`; OpenSpell uses
that corroborated path. The collection does not state the provider maximum
batch size, so OpenSpell's batch size of 100 is documented only as a
conservative local bound.

## Acceptance checks

- [x] No call uses the undocumented generic `/budgets/usage/campaigns` path.
- [x] SP, SB, and SD select their own endpoint deterministically.
- [x] Request bodies contain only the documented campaign-id list.
- [x] Every response index maps to exactly one requested campaign.
- [x] Missing, duplicate, out-of-range, mismatched, and malformed rows fail
  closed with `AdsApiParseError`.
- [x] `usage.length + failures.length === requested` follows from the parser's
  reconciliation rather than a comment at the call site.
- [x] Empty input performs no HTTP call.
- [x] The read safely exercises the shared 429 and 5xx retry behavior.
- [x] Fixtures are synthetic and no credential or live profile is used.

## Deferred integration

The worker may consume this client only after a separate package defines its
job, persistence, freshness, and stale-evidence behavior. A live capability
probe must verify availability and any provider batch ceiling per profile
before the UI calls the source authoritative.
