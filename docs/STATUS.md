# wizard-ads — program status board

Manager: Fable. States: `todo` · `in-progress` · `review` · `merged` · `gated`.

Reconciled 2026-08-29 against `origin/main` at `602a780`. Here, **merged** means the
implementation is reachable from that revision. It does not mean deployed, applied to a hosted
database, live-data verified, or accepted by an operator. Full evidence and source pointers:
`docs/workpackages/WP-52-reconciliation.md`. Work after WP-52 is integrated on
`wp-67-operator-upgrade-integration` for review and is not described as merged to `main`.

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
| 12 | Staged Amazon apply | gated | opens only after the v1 parity gate |
| 13 | Headless analyst | merged | deterministic read-only analysis surface |
| 14a | Campaign creation engine | merged | pure generator and export writer |
| 14b | Campaign creation via API | gated | gated behind live connection and write approval |
| 15 | Feedback and roadmap | merged | intake, voting and roadmap data model |
| 16 | AMC lane | gated | opens when the required account and storage prerequisites exist |
| 17 | AI skills library | merged | four read-only MCP-connected skills and lint contract |
| 18 | Source-labelled history import | merged | second-hand source isolation and crosscheck exclusion |
| 19 | Experiments | merged | tracking, windows, comparisons and change context |
| 21 | First UI redesign | merged | application shell, theme and sync controls; merge `0398e08` |
| 22 | Worker ↔ Ads API integration | merged | real client adapter and queue-backoff mapping; merge `085bc91` |
| 23 | Cron sync and profile UX | merged | scheduled queue pump and profile scheduling controls |
| 24 | AdLabs-fidelity UI | merged | dense operator surfaces derived from recon and an operator recording |
| 25 | Ads API write endpoints | merged | client capability only; global product write gate still applies |
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
| 52 | Repository reconciliation | review | documentation/evidence package on `wp-52-reconciliation` |

No tracked implementation brief exists for WP-20, WP-37, WP-45, or WP-46. Number gaps are not
treated as shipped packages. WP-47A has architecture/QA records and a merge commit but no numbered
implementation brief in `docs/workpackages/`.

## Current review wave

| WP | Package | State | Review-branch evidence |
|---|---|---|---|
| 53 | Design directions | review | three static branded previews; recommended Operator Console direction |
| 54 | MCP production setup | review | secured Evo container stack, dedicated Cloudflare Tunnel, two-client read/audit verification |
| 55 | Additive contracts and SP-API client | review | shared operator contracts plus pure `packages/sp-api` |
| 56 | Data foundations | review | additive migration, tenant RLS, count assertions; local PostgreSQL only |
| 57 | Report promotion and history planning | review | transaction-safe report-date replacement and bounded history planner; live loader gated |
| 58 | Creative Performance backend | review | Asset-ID mappings/facts, strict SB Video staging seam, ambiguity states |
| 59 | SQP and Query Intelligence | review | strict weekly SP-API seam, counted persistence, pure taxonomy, spend-conserving joins and contextual negatives; live queue gated |
| 60 | Stateful optimizer core | review | synchronization/observation gates, lift/hold/revert decisions and bounded de-rounding |
| 62 | Dayparting v0.5 backend | review | revision-safe ledger/hourly facts, DST/settling, bounded proposals and exports; SQS wiring gated |
| 63 | Operator Console UX | review | four-series chart, guided builder, recommendation grouping and nested grid |
| 64 | Roadmap reconciliation | review | deduplicated manifest with value, prerequisite and deferral reason |
| 67 | Integration and release evidence | review | serial integration, local verification and review handoff; production web verification remains gated |

## Milestone gates

- **v0 close:** OAuth and profile discovery; entity and campaign-fact sync on pilot profiles;
  minimal grid; generated goldens; recon specs. Current live satisfaction was not rechecked by
  WP-52.
- **v1 exit (gates WP-12):** 14 consecutive verified crosscheck days on at least five pilot
  profiles; campaign-grain tolerance for at least 95% of spending campaigns over a week; explained
  optimizer parity spot-check. No current evidence closes this gate.

## Dated live and deployed evidence

- The latest durable full-route production QA is `docs/design/QA-2026-08-27.md`. Its second round
  records the brand system, settling presentation, comparison-flow repairs, target bid columns,
  and Bugs/Roadmap split as live on that date.
- WP-54 supersedes the old MCP note: the service is healthy behind a dedicated Cloudflare Tunnel
  on the always-on operator host. Codex and Claude Code each discovered the same 11 analytical
  tools, completed a permitted real read, produced audit and last-used evidence, and received a
  not-found result outside the key's profile allowlist. No mutation tool is exposed.
- `docs/design/REDESIGN-2026-08-28.md`, WP-50, WP-51, and the final freshness fix are later Git
  evidence. The repository does not record which revision production currently serves, so they
  remain deployment-unverified.
- The web deployment inspected during this wave did not expose trustworthy Git metadata. A local
  or preview build therefore does not close the production-revision gate.
- Authenticated Chrome CDP reached Wizard Ads, AdLabs, and SYNQ tabs, but the first-party tab was
  blocked by the browser and the competitor tabs were at sign-in. No credential was entered and
  no competitor data or dashboard configuration was changed.

## Reconciled production behavior at `602a780`

- New schedule provisioning requests a 3-day recent window, a 32-day restatement window, and the
  preceding 32-day comparison window. The recent window overlaps the restatement window: distinct
  scheduled history is about 64 contiguous days.
- Entity tables are current-state mirrors with post-connection diffs in `entity_changes`.
- Fact reports upsert the canonical grain. Previous values are not versioned, rows omitted from a
  later report are not removed, and no request-order promotion watermark exists.
- Most daily facts retain 26 months; search terms retain 13 months. Older detail is rolled up
  monthly before its partitions are dropped.
- The UI uses a generic 14-day settling rule. There is no account-specific attribution-maturity
  model or observation history.
- Unified reporting, maximum-history bootstrap, exact coverage matrices, stale-row reconciliation,
  and attribution observations are absent from this `main` revision.

## Review-branch data foundations

- `packages/sp-api` now provides a pure Brand Analytics SQP client and strict weekly report-window
  helpers. Amazon calls still belong to the worker; web never receives a token.
- The additive operator-intelligence migration defines report coverage, bootstrap progress,
  promotion watermarks, attribution observations, Asset-ID creative facts, SQP vocabulary and
  proposals, optimization groups and observations, and Marketing Stream/dayparting storage.
  Migration and RLS tests use synthetic data on disposable PostgreSQL; the migration has not been
  applied to hosted Supabase.
- Report promotion now has a transaction boundary, exact staged/promoted/canonical counts, a
  newer-evidence watermark, stale-row removal for a complete report-date snapshot, and a retained
  pre-promotion attribution observation.
- The existing live parser cannot assign every refused source row to an exact date. The new
  replacement path is therefore not connected to production ingestion yet; deleting an old
  report-date snapshot before proving complete date-level input would be unsafe.
- The creative backend uses `(profile, Amazon Asset ID)` identity and explicit ad-to-creative-to-
  asset mappings. It records ambiguous, legacy, unsupported and unmapped states instead of
  attributing an ad group's facts to one guessed asset. The external Amazon report adapter and live
  count crosscheck remain gated on an authoritative response fixture.
- SQP now has strict Sunday-Saturday planning, one-marketplace requests, canonical ASIN batching,
  resumable exact-identity checkpoints, complete-report reuse, strict document parsing, counted
  transactional replacement, vocabulary approval preservation, spend-conserving PPC joins and
  routing-gated review proposals. The live queue cannot carry `sqp.request` until the authoritative
  job union/database enum and a durable feature-report checkpoint table are widened.
- Dayparting now has an append-only revision ledger, exact-source stale guards, normalized SP/SB/SD
  hourly facts, DST-local derivation, settling/revised states, confidence-shrunk proposals and
  CSV/JSON serialization. Its SQS subscriber has the equivalent queue-contract gate.
- The pure optimizer evidence engine covers synchronization conflicts, incomplete observation,
  insufficient evidence, supported lift and exact pre-change reversion. Worker scheduling and
  persistence remain open.

## Open repository follow-ups

- OAuth still carries the `INTEGRATE(WP-02)` client seam.
- `EntityTagFilter` remains DB-local instead of shared; `exportBatch` remains a route-local role
  constant instead of a central auth capability.
- Dashboard fact reads now label missing source dates honestly, but complete source provenance and
  coverage headers still require the live report-promotion path.
- Mirror chunks and later change-log writes are not one retry-convergent transaction; the negatives
  mirror also retains its cross-scope key-collision risk.
- Unknown match-type spellings remain target rows with a null match type.
- Report ingest does not create missing historical partitions before a backfill write.
- Query Intelligence, Creative Performance, Dayparting, Strategy, and Time Machine v2 remain open
  product surfaces even where their contracts or backend foundations now exist.

## Unverified release gates

- [x] GitHub CI run `33129362599` succeeded for exact `main` revision `602a780`.
- [x] Final review-branch `pnpm check` after the last integration commit. The root test runner now
      executes the unchanged UI frame-budget suite after the other Turbo packages; the complete
      isolated UI suite passed 149 of 149 instead of measuring unrelated CPU contention.
- [x] Additive migration, RLS, report promotion, roadmap, creative persistence and dayparting
      persistence suites executed against disposable PostgreSQL with synthetic fixtures. The final
      database package run passed 25 files and 194 tests; the worker package passed 18 files and
      163 tests against the same disposable database.
- [x] Workspace build passed; the web build generated the current route tree without production
      environment values.
- [ ] Exact deployed revisions for web and always-on worker.
- [x] Revision-stamped MCP health plus Codex and Claude discovery/read/audit/last-used/allowlist
      checks. Re-run after the final review-branch commit before handoff.
- [ ] Hosted migration ledger reconciled to the 30 tracked SQL migrations.
- [ ] Live coverage matrix and source precedence verified without client data entering Git.
- [ ] Full current Wizard Ads route/state click-through after the latest commits.
- [x] Local Playwright release suites: 26 production-build workflows and 27 authenticated-dev
      workflows passed, including dashboard, nested grid, campaign export, recommendations,
      experiments, Time Machine, tenancy, OAuth safety and every guarded route.
- [ ] Fresh AdLabs and SYNQ workflow comparison. AdLabs has a durable redacted baseline in
      `tools/recon`; SYNQ has no tracked workflow evidence.
- [ ] v1 crosscheck exit gate: consecutive verified days, campaign-grain parity, and explained
      optimizer spot-check.
