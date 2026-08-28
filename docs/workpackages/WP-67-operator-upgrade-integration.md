# WP-67 — Operator upgrade integration and release evidence

**Status:** review · **Owner:** Codex · **Branch:** `wp-67-operator-upgrade-integration`

## Goal

Integrate the verified WP-52 onward work on a fresh branch from `origin/main`, preserve the
read-only Amazon boundary, and distinguish implemented foundations from deployed and live-data
verified product behavior.

## Baseline

- The branch starts from `origin/main` at `602a78084e9e343335a21e4c81ddbe075f9796c9`.
- GitHub Actions run `33129362599` completed successfully for that exact revision.
- The prior local branch was not reused or overwritten.
- No hosted/shared migration or seed was run. Database verification used a disposable local
  PostgreSQL instance with synthetic fixtures.

## Integrated operator outcomes

### MCP

- `apps/mcp` runs as a dedicated Node 22 container behind a Cloudflare Tunnel on the always-on
  operator host. Cloudflare supplies ingress; the operator host supplies compute.
- The public service exposes `GET /healthz` and authenticated `POST /mcp`.
- Discovery returns analytical read tools only. The production catalog contains no Amazon-write
  or product-mutation tools.
- Key expiry, revocation, profile allowlists, audit logging, and `last_used_at` updates are
  enforced. Issuance requires an owned, non-empty profile allowlist and a bounded future expiry;
  verification also refuses legacy unscoped or non-expiring rows. Setup instructions refer to
  `WIZARD_ADS_MCP_TOKEN` and do not embed a secret.
- Codex and Claude Code each completed discovery, a real permitted read, audit verification,
  last-used verification, and a denied-profile check with a newly issued scoped key.
- The previously exposed key was revoked and never reused.

### Operator UX

- The recommended Operator Console direction reduces the dashboard to Spend, Ad Sales, Orders,
  and ACOS, and groups recommendation review by operator decision and reason.
- Trend analysis accepts up to four series, with line/bar and left/right-axis choices per series,
  daily/weekly/monthly aggregation, complete time bins, and exact period tooltips.
- Missing source dates are labelled honestly rather than presented as observed zero activity.
- Campaign Create and Update use guided recipes, naming tokens, validation, and live previews.
  Raw JSON remains available under Advanced, and the outcome remains an export.
- Grid grouping is an ordered, true hierarchy with add, move, remove, expand, and collapse
  controls. Derived totals are calculated once, collapsed descendants do not alter totals, and
  CSV export retains deepest matching rows without double-counting.
- The 3,597-row synthetic reference fixture was fully represented. The recorded p95
  filter/group response was below the 150 ms operator target.

### Data correctness foundations

- Shared contracts cover report coverage and attribution observations, Asset-ID creative facts,
  SQP/query intelligence, optimization observations/reversion provenance, and Marketing Stream
  hourly/dayparting facts. `packages/sp-api` is a pure client package; web receives no Amazon
  tokens.
- A locally verified additive migration defines the new tenant-scoped storage and RLS policies.
  It is not applied to a hosted database by this package.
- Report-date promotion stages and validates a complete report before atomically replacing that
  profile/report/date snapshot. A newer watermark wins, omitted rows are removed only after a
  complete promotion, and an attribution observation is retained before replacement.
- Maximum-history planning is bounded by the authoritative capability for each report instead of
  claiming lifetime history. The live fetch pipeline remains unchanged until refused rows can be
  attributed to exact report dates; enabling replacement before then could delete valid facts.
- Sponsored Brands Video persistence uses Amazon Asset ID as identity, requires explicit
  ad-to-creative-to-asset mappings, and reports ambiguous, legacy, unsupported, or unmapped states
  instead of guessing attribution. The external report adapter remains gated until its full
  response chain is verified.
- Query Intelligence is implemented as pure functions: boundary-safe vocabulary matching, six
  preserved categories plus presentation labels, human-review states, customer-search-term intent
  for Sponsored Brands, like-for-like rollups, spend-conserving SQP/PPC joins, contextual ad-group
  negative proposals, and parameterized SUPA flags. Live ingestion, persistence, approval UI and
  Amazon Audit parity remain separate evidence gates. The adapter-ready SP-API workflow adds exact
  Sunday-Saturday planning, one marketplace per request, canonical ASIN batches, resumable
  exact-identity checkpoints, completed-report reuse, strict payload validation, transactional
  complete-scope replacement and human-decision preservation. Sorted per-ASIN transaction locks
  and immutable source-report promotion runs reject an older overlapping request before canonical
  deletion and make an exact retry a checked no-op.
- The pure optimizer evidence engine validates immutable group context, refuses compounding until
  the exported value is synchronized and its observation window is complete, compares
  de-duplicated matched pre/post volume, continues only with lift evidence, and proposes the exact
  pre-change value after complete no-lift evidence. Constraints are applied before legal
  one-cent bid or one-point placement de-rounding, and every adjustment records provenance.
- Dayparting v0.5 persists an append-only Marketing Stream ledger and replaces an hourly fact only
  from the exact latest source-event revisions under a per-scope advisory lock. SP, SB and SD
  traffic/conversion/budget events normalize to UTC and DST-aware profile-local hours with
  settling/revised states and budget-cap signals. Confidence-shrunk schedules merge adjacent
  equivalent hours and serialize to CSV or JSON. The live SQS subscriber is gated on promoting
  the feature payload into the authoritative queue contract and database enum.

## Evidence gates

- `pnpm check` passed on the review branch after the final code integration commit. It ran the
  workspace typechecks, lint, non-DB-backed Vitest suites, public-repo hygiene and skill lint. The
  UI performance suite runs after the other Turbo package suites so its unchanged wall-clock budget
  measures the code rather than CPU contention from unrelated tests.
- The full database package passed against disposable PostgreSQL: 25 files and 197 synthetic
  tests, including migration/RLS coverage, roadmap manifest, report promotion, creative,
  SQP, and dayparting persistence. The worker package passed 18 files and 163 tests against
  the same disposable database, including retry and idempotency paths. The MCP package passed
  55 tests against the disposable database, including refusal of unsafe legacy key shapes.
- Playwright passed both local release suites after the final SQP integration: 26 production-build workflows and 27
  authenticated-dev workflows. Coverage includes guided campaign export, four-series dashboard
  controls, nested grid grouping, recommendations, experiments, tags, feedback, OAuth/role safety,
  every guarded route, and Time Machine flows.
- `pnpm build` passed; the web build generated the current route tree without production
  environment values.
- An independent high-reasoning release review found two medium issues: unsafe legacy MCP key
  shapes and stale SQP promotion. Both were fixed and regression-tested; a follow-up review is
  required after their integration.
- The web production revision remains unverified unless a revision-stamped deployment is recorded
  separately. A passing local or preview build is not described as production behavior.
- Authenticated competitor and production route QA remains blocked until the existing Chrome tabs
  are signed in. No competitor data or accidental dashboard widget was changed.

## Explicitly incomplete

- Hosted application of the additive migration and roadmap manifest.
- The live Ads adapter for SB Video, the live SQP queue/connection wiring and approval surface, and
  authoritative row-count crosschecks.
- Database/worker scheduling and persistence for the stateful optimization evidence loop, plus
  Time Machine v2 conflict-safe inverse exports.
- Live Marketing Stream queue wiring, SQS/DLQ deployment and payload validation, revised-hour
  rescheduling, retention benchmarking, and the Dayparting web surface.
- The selected product surfaces for Creative Performance, Query Intelligence, Strategy,
  Dayparting, and experiment cohort analysis.
- Authenticated deployed Wizard Ads, AdLabs, and SYNQ click-through comparison.
- The v1 crosscheck gate and every Amazon write capability.

These stay as work-package or roadmap items. They are not counted as complete because a contract,
schema, or local implementation exists.

## Safety record

- No Amazon write API was invoked.
- No production/shared migration or seed was run.
- No credential, client data, doctrine threshold, absolute home path, or private reference
  material was added to the repository.
- Competitor sessions were read-only and the known accidental AdLabs widget was untouched.
