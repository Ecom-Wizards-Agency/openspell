# OpenSpell — program status board

Snapshot cut 2026-08-30 from `origin/main` at
`f1b9efc1813247ab72a36dbeca56e1e96bf069d1`. Here, **merged** means the implementation is
reachable from that revision. It does not by itself mean live-data verified, deployed, or
accepted by an operator. Full original evidence and source pointers are in
`docs/workpackages/WP-52-reconciliation.md`; the post-release capability design is in
`docs/workpackages/WP-68-outstanding-capabilities-design.md`.

## Verified current snapshot

| Surface | Verified state at the snapshot |
|---|---|
| Repository | `origin/main` is `f1b9efc` and includes merged PRs #36 and #37. Both passed typecheck, lint, tests, hygiene and Playwright on their exact PR heads before merge. Exact-main Actions jobs now fail before a runner starts because the organization reports failed payments or an insufficient Actions spending limit; this is an infrastructure block, not code execution evidence. The last successful exact-main run remains `6795fee`. |
| Production web | Healthy and intentionally held at `caff194`. Nine authenticated operator routes returned HTTP 200 with no page or console error after rollback. Main is ahead and is not yet deployed. A fresh authenticated navigation now serves the legacy `wizard-ads` label and `w` placeholder, while `/brand/wizards-ai-icon.svg` returns HTTP 404 even though current main contains the verified official asset. |
| Deployment environment | Newer candidates consumed corrupted or malformed production runtime-secret metadata after the healthy build. The authoritative 1Password service-account session is unavailable, so values have not been safely restored. No further production promotion is allowed until an immutable candidate passes the release gate. |
| Hosted database | The production migration ledger is applied exactly through `20260829160100_sb_video_observed_ingestion.sql`. No unmerged write-gateway migration has been applied. |
| MCP | A fresh unauthenticated health check reports ready with a ready database, but the public service still identifies itself with the legacy product name and an older ancestor revision. Earlier Codex and Claude Code read/audit checks therefore remain historical evidence; exact-main activation is blocked on authoritative server environment recovery from 1Password. |
| Amazon writes | No production migration or Amazon write from the open SP write-gateway PR has run. PR #24 remains open and is not merge-safe pending independent safety review. |

Since the prior status cut, the first-parent history adds merged PRs #18–23, #25–32, #34,
#36 and #37. PRs #24, #33, #35 and #38 remain open; a gap in PR numbers is not treated as
merged work.

## Repository state

| WP | Package | State | Repository evidence |
|---|---|---|---|
| 00 | Scaffold and shared contracts | merged | workspace, contracts, CI and hygiene foundation |
| 00.1 | Strategy contract extension | merged | widening-only contract merge `fb4822e` |
| 01 | Database schema and RLS | merged | base schema, tenant RLS and partition automation |
| 02 | Ads API client | merged | pure client, entities, reports, budgets and guarded write surfaces |
| 03 | Worker and queue | merged | resumable queue and three-pass report pipeline |
| 04 | Web auth and OAuth | merged | tenant auth, connection flow and sync status |
| 05 | Doctrine engine | merged | pure recommendation math and parity fixtures |
| 06 | Grid and dashboard | merged | virtualized grid, aggregation and dashboard |
| 06b | Design audit fixes | merged | token bridge, roster paging and MCP endpoint correction |
| 07 | Recommendation review and export | merged | preview, provenance, n-grams and export-only handoff |
| 08 | Tags and goto links | merged | nested tags, assignment, scoped links and RLS checks |
| 09 | MCP server | merged | read tools, scoped keys and audit log; deployment not implied |
| 10 | Crosscheck harness | merged | ingest, verdict and exit-report tooling |
| 11 | AdLabs recon | merged | tagged specs and 13 redacted screenshots under `tools/recon` |
| 12 | Staged Amazon apply | superseded | replaced by the WP-93 guarded write-gateway contract; runtime work remains open |
| 13 | Headless analyst | merged | deterministic read-only analysis surface |
| 14a | Campaign creation engine | merged | pure generator and export writer |
| 14b | Campaign creation via API | planned | authorized direction under WP-93; guarded runtime and product support remain open |
| 15 | Feedback and roadmap | merged | intake, voting and roadmap data model |
| 16 | AMC lane | gated | opens when the required account and storage prerequisites exist |
| 17 | AI skills library | merged | four read-only MCP-connected skills and lint contract |
| 18 | Source-labelled history import | merged | second-hand source isolation and crosscheck exclusion |
| 19 | Experiments | merged | tracking, windows, comparisons and change context |
| 21 | First UI redesign | merged | application shell, theme and sync controls; merge `0398e08` |
| 22 | Worker ↔ Ads API integration | merged | real client adapter and queue-backoff mapping; merge `085bc91` |
| 23 | Cron sync and profile UX | merged | scheduled queue pump and profile scheduling controls |
| 24 | AdLabs-fidelity UI | merged | dense operator surfaces derived from recon and an operator recording |
| 25 | Ads API write endpoints | merged | client capability only; the immutable approval and worker execution runtime remains open in WP-96 |
| 26 | Bidding corridor engine | merged | pure bid-boundary calculations |
| 27 | Suggested bids and SB media | merged | read-side suggested bids and SB media/creative client surfaces |
| 28 | Bid corridor series and charts | merged | daily corridor observations and first chart surface |
| 29 | Live-sync report fixes | merged | pagination, per-product isolation and legal report windows |
| 30 | Time Machine v1 | merged | read-only change timeline |
| 31 | Audit fixes | merged | sync, retry, scoping and window hardening |
| 32 | Sync pipeline fixes | merged | parser delegation, chunking, duplicate checks and honest failures |
| 33 | Recommendations runner | merged | preview-only runner, lifecycle and Run now; merge `3e33bc3` |
| 34 | Profile/feedback quick fixes | merged | sync-aware selection, persistence and page context; merge `758872d` |
| 35 | Bug widget and board | merged | intake, board, similar-item read and duplicate seam; merge `37257c6` |
| 36 | CI hardening | merged | Postgres-backed checks and serial Playwright job; merge `ed9e65f` |
| 38 | Invitations and password auth | merged | invite-only schema and acceptance flow; merge `1382dd5` |
| 39 | Members and account settings | merged | member/account surfaces and tests; merge `e0862ae` |
| 40 | Integration connections | merged | provider custody and settings UI; merge `8686975` |
| 41 | Queue contract and always-on worker | merged | filtered claims, integration jobs and runbook; merge `cb56eca` |
| 42 | Keepa integration | merged | scoped client, persistence and handler; merge `e72525e` |
| 43 | DataDive integration | merged | client, wire validation and rank sync; merge `6c7e01c` |
| 44 | Product economics integration | merged | client, persistence and handler; merge `888ceab` |
| 44B | Product economics live-shape fit | merged | parser/handler corrections; merge `b56b4cb`; current parity unverified |
| 47A | Live QA fixes | merged | comparison, settling, run-state, filter and label repairs; merge `b20f815` |
| 47B | Brand design system | merged | tokens, typography, components, charts and empty states; merge `8dcbd65` |
| 48 | Target-level bid history | merged | target modal and bid-context columns; merge `e44e21e` |
| 49 | Bugs/Roadmap split | merged | separate operator surfaces and feature intake; merge `c745f69` |
| 50 | Campaign builder update mode | merged | synced-state diff and export-only update flow; merge `b1ca073` |
| 51 | Test backlog and stock gate | merged | test proposals and stock/rank preconditions; merge `517f379` |
| 52 | Repository reconciliation | merged | documentation/evidence package included in the operator-upgrade release |

No tracked implementation brief exists for WP-20, WP-37, WP-45, or WP-46. Number gaps are not
treated as shipped packages. WP-47A has architecture/QA records and a merge commit but no numbered
implementation brief in `docs/workpackages/`.

## Operator-upgrade release

| WP | Package | State | Release evidence |
|---|---|---|---|
| 53 | Design directions | merged | three static branded previews; Operator Console direction implemented |
| 54 | MCP production setup | merged; older revision deployed | secured always-on container stack, Cloudflare Tunnel and two-client read/audit verification; exact-main activation is environment-gated |
| 55 | Additive contracts and SP-API client | merged | shared operator contracts plus pure `packages/sp-api` |
| 56 | Data foundations | merged and hosted | additive migration, tenant RLS and count assertions; hosted ledger verified |
| 57 | Report promotion and history planning | merged | transaction-safe report-date replacement and bounded history planner; live loader gated |
| 58 | Creative Performance backend | merged | Asset-ID mappings/facts, strict SB Video staging seam, ambiguity states |
| 59 | SQP and Query Intelligence backend | merged | strict weekly SP-API seam, counted persistence, pure taxonomy, spend-conserving joins and contextual negatives; live queue gated |
| 60 | Stateful optimizer core | merged | synchronization/observation gates, lift/hold/revert decisions and bounded de-rounding |
| 61 | Time Machine v2 | merged and hosted | export-time mirror snapshots, exact row-level sync attribution, conflict-safe inverse exports |
| 62 | Dayparting v0.5 backend | merged | revision-safe ledger/hourly facts, DST/settling, bounded proposals and exports; SQS wiring gated |
| 63 | Operator Console UX | merged and deployed | four-series chart, guided builder, grouped recommendations and nested grid |
| 64 | Roadmap reconciliation | merged | deduplicated manifest with value, prerequisite and deferral reason |
| 67 | Integration and release evidence | merged and deployed | historical exact-revision proof for release CI, hosted migrations, production web and MCP |

## Current implementation wave

| WP | Package | State | Boundary |
|---|---|---|---|
| 68 | Outstanding capability reconciliation and design | merged | verified gap map and serialized domain-workspace architecture |
| 69 | Persistent optimization groups | merged | atomic settings/assignments, group-scoped worker runs, anti-compounding evidence gate and operator UI |
| 70 | Creative Performance UI | merged | Asset-ID-first Creative read surface with drill-down and explicit unsupported states |
| 71 | Query Intelligence UI | merged | weekly taxonomy, share, opportunity and contextual-negative review surface |
| 72 | Dayparting UI | merged | local-time heatmap, confidence, settling and CSV/JSON proposal export |
| 73 | Marketing Stream SQS runtime | merged; live gated | SQS receipt, raw-first retention, acknowledgement, retry and read-time settling are implemented; subscription/fanout is not provisioned |
| 74 | Integrated release verification | merged and deployed | local DB/RLS/unit/build, hosted CI and 54 Playwright workflows passed for the operator-workspace release |
| 75 | Durable weekly SQP worker | merged; live gated | report identity/checkpoint reuse and pending deferral survive retry/restart; WP-79 adds the missing authentication and scheduler path, while hosted provider configuration remains gated |
| 76 | Grid cold start | merged | crosscheck evidence streams outside the row critical path; the 3,597-row server query and mapping fixture completes under two seconds |
| 77 | Recommendation observation reconciler | merged | exact synchronized bid evidence and settled matched pre/post facts drive hold, continue or exact reversion without compounding |
| 78 | Release evidence and status reconciliation | merged and deployed | combined-tree verification and the operator-workspace deployment completed; current-revision QA is recorded below |
| 79 | SP-API profile binding and SQP scheduling | merged and hosted; live provider gated | exact profile/marketplace binding, Vault custody, LWA refresh and weekly due-work scheduling; tenant binding, provider configuration and live report parity remain gated |
| 80 | Web database pool HMR reuse | merged and deployed | one non-production pool survives Next.js route recompilation; the prior PostgreSQL client-exhaustion Playwright failure is covered by module-reload and full browser tests |
| 81 | Current release status reconciliation | merged | evidence-only baseline at `48b9625`; merge `d6a1e6b` |
| 82 | Quiet public application shell | merged and deployed | anonymous routes use the compact public frame and server-gate feedback controls; authenticated operator navigation is unchanged |
| 83 | SB Video contract probe | merged; live gated | non-persisting readers and count-only reconciliation prove documented shapes; no authorized live probe has run |
| 84 | Transactional SP report promotion | merged; live gated | complete-date replacement is wired for four SP report grains; live worker count review remains open |
| 85 | Observed SB Video ingestion | merged and hosted; live parity gated | current-snapshot ad/version-to-Asset-ID mapping and same-day fact gates are deployed; authoritative provider counts and live mapping parity remain open |
| 89 | Operator workspace refinement | merged and deployed | compact freshness, active-account context, date presets, filter-aware selection, grouped flags, campaign-first optimizer, target corridor context and chart persistence |
| 90 | Optimization weekday schedule | open; code-approved | PR #40 replaces interval-only cadence with profile-local weekday/time controls, preserves legacy fields during the additive transition, and keeps scheduled runs preview-only. Independent exact-head review found no P0/P1/P2. The author's full local check, build, disposable-database, worker, web and focused browser suites pass; merge remains held until hosted jobs execute rather than terminate at zero steps. |
| 91 | Live performance acceptance | in progress | web critical paths have two merged optimization waves, but the live under-two-second and interaction p95 gates remain open |
| 93 | Guarded Amazon write-gateway policy | merged | operator-approved worker-only writes are authorized by policy; no runtime write path from this package is live |
| 94 | Operator authorization policy | merged | package boundaries and bounded live-test authorization were updated without tracking profiles or credentials |
| 95 | Web critical-path performance | merged and deployed | request-local identity reuse, process-owned database pooling, streamed secondary evidence and concurrent optimizer reads |
| 96 | Guarded SP write runtime | open; not merge-safe | PR #24 remains under independent adversarial safety review. The frozen head does not yet guarantee the reserved inverse slot against a second approval, and its observation/recovery path still depends on mutable authorization state. Hosted jobs cannot start because of the Actions billing block; its migration is unapplied and no Amazon call has run. |
| 97 | Freshness-ledger compatibility | merged and deployed | the web selects only fields available in the hosted report ledger |
| 98 | OpenSpell brand mark | merged; live artifact stale | the tracked SVG is byte-for-byte identical to the approved Wizards AI symbol and source replaces the placeholder letter. A fresh production navigation still renders the legacy `wizard-ads`/`w` shell and returns HTTP 404 for the SVG, proving the current artifact is not deployed. |
| 99 | Vercel environment boundary | merged and deployed | server runtime variable names pass through Turborepo without committing values |
| 100 | Query and loader performance | merged; not deployed | opt-in sanitized timings, campaign-grain preaggregation, parallel newest-run evidence and an exact grid overflow sentinel |
| 101 | Frankfurt function placement | superseded | the setting was tested but reverted before promotion after the candidate failed full-route QA |
| 102 | Active-profile canonicalization | merged; not deployed | canonical profile selection and `?profile=` propagation cover Dashboard, Grid, Optimizer, Groups, Creative, Recommendations and Campaign Builder; PR #30 passed both hosted gates |
| 103 | Semantic chart defaults | merged; not deployed | Spend defaults to bar/left and Ad Sales to line/right while saved profile choices still win |
| 104 | Safe region rollback | merged | main again uses the previously verified Vercel function-region configuration |
| 105 | Immutable release-candidate gate | merged | GET-only authenticated verification covers eleven critical routes and fails before production promotion on bad status, content or application errors |
| 106 | Focused recommendation review | merged; not deployed | compact filters, exact filtered selection and one action bar replace three equal-weight prequeue panels while preserving exact export confirmation |
| 110 | Task-focused navigation | merged; not deployed | the shell removes low-value filler navigation and keeps the operator workspace primary |
| 112 | Release artifact assertions | open; code-approved | PR #35's frozen head has exact revision, production-target binding, official-logo, active-account/date-range, focused-review, real-curl, raw-host and bounded large-response assertions. Exact-object independent review found no P0, P1 or P2; the full local suite and production build pass. Merge remains held because hosted jobs still cannot start under the Actions billing block. |
| 113 | OpenSpell MCP identity | merged; host activation gated | setup and operator copy use OpenSpell while stable environment-variable and package identifiers remain compatible |
| 114 | Date-range browser gate | merged; not deployed | Dashboard and Grid exercise all seven preset ranges through authenticated Playwright |
| 116 | Hydration/readiness reliability | open; code-approved | PR #38 now fails closed until exact saved-state restoration, fails open from malformed cache/store errors, and covers schedule plus exact select-all/bulk persistence. Two independent reviews found no remaining P0/P1; merge is held because required hosted jobs cannot start under the Actions billing block. |
| 117 | Operator route acceptance closure | open; code-approved | PR #39 adds test-only browser coverage for all fourteen Optimizer/Creative preset interactions with exact periods and canonical profile scope, plus the Strategy-to-Dashboard viewport destination. Independent review found no P0/P1; merge is held because hosted jobs cannot start under the Actions billing block. |
| 118 | Exact-revision web performance | in progress | A current-main source audit found that internal sidebar, profile and Grid-entity navigation still trigger full-document loads. It also proved that the 3,597-row loader fixture excludes authentication, RSC transfer, hydration and saved-layout readiness. An isolated package is adding sanitized exact-revision timings and safe App Router navigation before any new production-speed claim. |

## Milestone gates

- **v0 close:** OAuth and profile discovery; entity and campaign-fact sync on pilot profiles;
  minimal grid; generated goldens; recon specs. Current live satisfaction was not rechecked by
  WP-52.
- **v1 evidence criterion:** 14 consecutive verified crosscheck days on at least five pilot
  profiles; campaign-grain tolerance for at least 95% of spending campaigns over a week; explained
  optimizer parity spot-check. No current evidence closes this criterion; it gates scaled
  automation, while individual manually approved batches use the stricter WP-93 action gates.

## Verified runtime and deployment evidence

- The production web application remains on the healthy `caff194` build. After a candidate was
  rejected and aliases were restored, authenticated checks covered Dashboard, Grid, Optimizer,
  Creative, Campaigns, Recommendations, Tags, Time Machine and Integrations: nine of nine returned
  HTTP 200 with no page or console error.
- A fresh authenticated Chrome check found material artifact drift despite those HTTP checks:
  Dashboard and Creative expose the seven preset date choices, while deployed Grid omits the
  active-account/date-range component that exists in current source. A new Grid tab took about
  6.6 seconds to load and a warm reload about 5.6 seconds; response streaming, not initial response
  latency, consumed most of the wait. One synthetic no-match filter transition completed in 71 ms,
  which is encouraging interaction evidence but not a p95 benchmark. Candidate verification must
  therefore assert distinctive current UI artifacts as well as headings and status codes.
- The same artifact check proves the branding drift directly: the source SVG matches the approved
  Wizards AI symbol byte-for-byte, but a fresh authenticated production navigation serves the
  legacy `wizard-ads` label with a `w` placeholder, has no brand-mark background image, and returns
  HTTP 404 for the tracked SVG path. A local Next.js server from the reviewed release branch serves
  that exact tracked asset as `image/svg+xml` with HTTP 200 and an identical content hash, isolating
  the defect to release drift rather than asset packaging. PR #35 adds a
  candidate asset request and authenticated DOM marker gate so a heading match cannot hide this
  class of stale deployment again.
- A later production-target candidate inherited malformed database/runtime secret metadata and
  returned HTTP 500 on four database-backed routes. The healthy and failing builds had 1,147
  byte-identical artifact files; the relevant production secret metadata had changed after the
  healthy build. This isolates the failure to deployment environment state rather than application
  code or the experimental function region. Production remains intentionally drifted until the
  authoritative values can be restored from 1Password and verified without exposing them.
- The immutable-candidate verifier added in WP-105 passed all eleven authenticated routes on the
  healthy candidate, rejected the broken candidate on the four failing routes and refused an
  unrelated host before reading browser cookies. Future release order is candidate without alias,
  verifier, promotion, then a fresh authenticated production pass.
- The hardened verifier in open PR #35 was tested with the real curl parser, the Grid's real
  default and explicit Campaigns state, a response larger than the old two-megabyte ceiling, an
  over-limit response, a non-production deployment target and raw host variants. Its consolidated
  local checks pass, and independent exact-object review found no remaining P0, P1 or P2. Hosted
  checks remain a separate unfinished gate.
- Co-location remains worth retesting after environment recovery. On successfully rendered routes,
  the Frankfurt candidate measured Grid and Optimizer repeat loads around 0.7–0.8 seconds versus
  roughly 2.4–3.3 seconds on the prior production placement; Creative measured around 0.6–0.9
  seconds versus roughly 1.7–1.9 seconds. Because the candidate failed other routes, these are a
  performance signal, not release acceptance evidence.
- The production migration ledger was checked through
  `20260829160100_sb_video_observed_ingestion.sql`. This includes the feature-job, SP-API binding,
  SB Video report-type and observed-ingestion migrations that older status snapshots still called
  unapplied. No migration from open PR #24 has run.
- The public MCP health endpoint and tool catalog were verified on an older application revision.
  Codex and Claude Code each discovered the same eleven analytical tools, found no write-like tool,
  completed one permitted real read, created an audit record and advanced last-used state. Exact-main
  host activation remains blocked because the authoritative 1Password service-account session is
  unavailable. A fresh health request confirms the existing service and database are ready, while
  its legacy product identity and older ancestor revision make the deployment drift explicit.
- The pre-release visual record remains in `docs/design/QA-2026-08-27.md`. It is historical evidence,
  not proof that current main is deployed.

## Reconciled ingestion behavior

- New schedule provisioning requests a 3-day recent window, a 32-day restatement window, and the
  preceding 32-day comparison window. The recent window overlaps the restatement window: distinct
  scheduled history is about 64 contiguous days.
- Entity tables are current-state mirrors with post-connection diffs in `entity_changes`.
- Accepted complete Sponsored Products campaign, targeting, search-term and placement report dates
  now replace their canonical snapshots transactionally under request-order watermarks. Sponsored
  Brands and Sponsored Display remain on the prior upsert loader, and canonical metric revisions
  are not otherwise versioned.
- Most daily facts retain 26 months; search terms retain 13 months. Older detail is rolled up
  monthly before its partitions are dropped.
- The UI uses a generic 14-day settling rule. Accepted SP promotions retain pre-promotion
  observations, but there is no validated account-specific attribution-maturity curve.
- Unified reporting, maximum-history bootstrap and a live-verified coverage matrix remain absent.
  Stale-row reconciliation now applies only to accepted complete SP report dates.
- Amazon's current unified-reporting availability table documents hour-grain Reporting API data
  with a 14-day history and 14-day maximum pull. OpenSpell has not implemented or live-verified
  that beta path, so it is a bounded bootstrap candidate rather than a substitute for the
  forward, near-real-time Marketing Stream ledger.

## Released data foundations

- `packages/sp-api` now provides a pure Brand Analytics SQP client and strict weekly report-window
  helpers. Amazon calls still belong to the worker; web never receives a token.
- The additive operator-intelligence migration defines report coverage, bootstrap progress,
  promotion watermarks, attribution observations, Asset-ID creative facts, SQP vocabulary and
  proposals, optimization groups and observations, and Marketing Stream/dayparting storage.
  Migration and RLS tests use synthetic data on disposable PostgreSQL; the migration is also present
  in the verified hosted ledger.
- SP report promotion now has a transaction boundary, exact staged/promoted/canonical counts, a
  newer-evidence watermark, stale-row removal for a complete report-date snapshot, and a retained
  pre-promotion attribution observation. The four SP parsers fail the report before deletion when
  any source row or requested date is unaccounted for. SB and SD are deliberately unchanged; one
  read-only production report per supported SP grain still needs a sanitized count crosscheck.
- The creative backend uses `(profile, Amazon Asset ID)` identity and explicit ad/version-to-asset
  mappings while keeping `creativeId` nullable. WP-85 adds counted current-snapshot observations,
  mapping-only default behavior and an explicit profile-local same-day gate before ad-level facts.
  It records ambiguous, legacy, unsupported and unmapped states instead of attributing an ad
  group's facts to one guessed asset. Its migrations and runtime are deployed at `caff194`; the
  authoritative provider count and mapping crosscheck has not occurred.
- SQP now has strict Sunday-Saturday planning, one-marketplace requests, canonical ASIN batching,
  resumable exact-identity checkpoints, provider report-ID reuse across retry/process restart,
  pending-result deferral without failure-budget consumption, strict document parsing, counted
  transactional replacement, vocabulary approval preservation, spend-conserving PPC joins and
  routing-gated review proposals. Overlapping promotions take sorted per-ASIN transaction locks
  and reject stale evidence from an immutable source-report freshness ledger before deletion. The
  WP-79 adds an exact advertising-profile/marketplace to SP-API account binding, service-role-only
  Vault custody, LWA token caching and one-time unauthorized retry, counted active advertised-ASIN
  selection, and a weekly due-work scheduler. Its additive migration is hosted. Live execution
  remains gated on configuring the deployment-owned LWA application and app role, creating tenant
  bindings, and proving count parity with one real read-only report.
- Dayparting now has an append-only revision ledger, exact-source stale guards, normalized SP/SB/SD
  hourly facts, DST-local derivation, settling/revised states, confidence-shrunk proposals and
  CSV/JSON serialization. The optional SQS consumer uses the standard AWS credential chain,
  retains valid raw events when modelling policy is absent, acknowledges only after counted
  projection, and keeps retry/health details sanitized. No live subscription has been provisioned.
- The pure optimizer evidence engine covers synchronization conflicts, incomplete observation,
  insufficient evidence, supported lift and exact pre-change reversion. The worker reconciler
  links one export row to synchronized bid history and starts matched evaluation on the next full
  profile-local day. Group scheduling and persistence refuse overlapping previews and hold after
  export until the latest observation is complete with a `continue` decision. Tenant strategy
  supplies the evidence policy without source defaults; `hold` and `revert` remain review gates.
- Creative Performance, Query Intelligence and Dayparting are guarded operator surfaces; the
  Strategy Overview was consolidated into Dashboard in WP-89. Empty or incomplete sources remain
  visible as source gates instead of demo performance.
- Historical live PPC rows in Query Intelligence are intentionally profile-only. The current
  `product_ads` mirror is not dated and therefore cannot prove an ASIN assignment for an earlier
  SQP week; exact joins remain available only to authoritative dated inputs.

## Open repository follow-ups

- OAuth still carries the `INTEGRATE(WP-02)` client seam.
- `EntityTagFilter` remains DB-local instead of shared; `exportBatch` remains a route-local role
  constant instead of a central auth capability.
- Dashboard fact reads now label missing source dates honestly, but complete source provenance and
  coverage headers still require the live report-promotion path.
- Mirror chunks and later change-log writes are not one transaction, but eligible export evidence
  now reconciles on every entity-pass retry and is protected by a one-link-per-export-row invariant.
  The negatives mirror still retains its cross-scope key-collision risk.
- Unknown match-type spellings remain target rows with a null match type.
- Report ingest does not create missing historical partitions before a backfill write.
- Loading speed is an open priority acceptance gap. Earlier Grid and Time Machine first-load checks
  measured 4.27 seconds and 5.36 seconds; later Grid checks ranged from roughly 3.2 seconds to 6.6
  seconds, with a 5.6-second warm reload in the current Chrome session. Grid filter and grouping
  must also demonstrate p95 response below 150 ms
  on the reference development machine; synthetic fixture success does not close either live
  performance gate.
- A fresh current-main audit identified the highest-confidence warm-navigation defect: several
  internal controls use plain anchors or `window.location.href`, repeating the full document,
  authenticated layout and hydration path. It also measured the synthetic 3,597-row Grid shape at
  roughly 1.64 MB before compression. WP-118 therefore measures exact-revision route readiness and
  replaces those reloads before SQL or pool changes are justified from stale-deployment timings.
- Hosted SQP configuration and the SB Video provider adapter remain open. The new product surfaces are complete for
  stored evidence, but cannot establish live Amazon parity until those adapters produce counted,
  authoritative rows. WP-83 proves the documented `adId`, nested creative, Asset-ID and `sbAds`
  shapes without persistence; WP-85 implements the current-snapshot `adId + creativeVersion`
  observation model without inventing `creativeId`. The migration and runtime are hosted, but an
  authorized live count probe remains required, and the snapshot does not establish historical
  mapping authority. Ad-group performance must never be guessed onto one asset. Time Machine v2 is
  hosted and deployed, but a live reversion cannot be end-to-end verified until an eligible export
  batch exists.
- Optimization-group free-text exclusions are explicitly reference metadata. Typed, enforceable
  exclusion rules remain a separate contract/work package rather than silently matching names.

## Release gates

- [x] PR #31 passed both hosted gates before merge. Exact-main CI run `33266608069` then completed
      successfully at `9717c8b`, including the fast gate and serial Playwright.
- [x] The status branch reconciled with current main passed the full local `pnpm check` gate:
      typecheck, lint, unit tests, UI performance tests, hygiene and MCP skill lint. This is useful
      combined-tree evidence, but does not replace hosted Actions or browser QA.
- [x] Production `caff194` passed a fresh authenticated nine-route click-through after rollback.
- [x] The release-candidate verifier passed eleven of eleven routes on the healthy immutable
      candidate and rejected the known broken candidate.
- [x] The production migration ledger is applied exactly through
      `20260829160100_sb_video_observed_ingestion.sql`.
- [x] Public MCP health, discovery, one real read, audit recording, last-used advancement and
      profile-scope refusal were verified from both supported clients on its deployed revision.
- [ ] Restore the authoritative production runtime values from 1Password, then validate a
      production-target immutable candidate before moving any alias.
- [ ] Repair the GitHub organization payment or Actions spending-limit state. Current required
      jobs terminate before any runner or repository step begins, so newer PR heads cannot earn
      hosted release evidence. A fresh retry across PRs #24, #35 and #38 again produced six
      zero-step failures with the same billing annotation.
- [ ] Deploy a reviewed current-main descendant only after the immutable gate passes, then repeat
      full authenticated route, error, data and timing QA on the production domain.
- [x] Active-profile canonicalization passed both hosted gates and merged through PR #30.
- [ ] Resolve PR #24's independent write-safety review. Preview its exact migration separately;
      do not apply it or call Amazon merely because local checks are green.
- [ ] Prove one authoritative SB Video Asset-ID mapping/fact count crosscheck and one read-only SP
      report per supported grain without putting profile data in Git.
- [ ] Configure and verify the weekly SQP provider path and the Marketing Stream subscription;
      their schemas are hosted, but live source parity remains open.
- [ ] Close the live under-two-second usability target and p95 filter/group target with a realistic
      account after the deployment environment is repaired.
- [ ] Run a fresh read-only AdLabs and SYNQ workflow comparison. The tracked AdLabs evidence is a
      historical baseline; SYNQ still lacks a durable redacted workflow record.
- [ ] Close the crosscheck exit gate: consecutive verified days, campaign-grain parity and an
      explained optimizer spot-check before scaled automation.

## Evidence sources and uncertainties

- Repository claims come from the `origin/main` first-parent graph, GitHub PR state/checks and the
  tracked migration list at the snapshot SHA.
- Runtime claims come from authenticated browser route checks, immutable-candidate verification,
  sanitized Vercel deployment/artifact metadata, the hosted migration ledger and the two MCP client
  checks. No credential value or client identifier was copied into this record.
- Production secret values could not be inspected or restored because the authoritative 1Password
  service-account session is unavailable. The diagnosis is supported by update timestamps,
  identical build artifacts and request failures, but final closure requires a fresh authoritative
  sync and candidate pass.
- Current main has not been promoted, the exact-main MCP service has not been activated and PR #24
  is still in safety review. Code presence or green CI does not close any of
  those runtime gates.
