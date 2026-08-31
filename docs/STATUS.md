# OpenSpell — program status board

Manager: Fable. States: `todo` · `in-progress` · `review` · `merged` · `gated`.

Source and deployment headers reconciled 2026-09-01 against `origin/main` at `d75ec26`. The
implementation-wave table remains incomplete after WP-148; `docs/HANDOVER.md` is authoritative for
the active continuation until the next live deployment/QA reconciliation. Here, **merged** means
the implementation is reachable from the recorded main revision. It does not by itself mean
live-data verified, deployed, or accepted by an operator. Full original evidence and source
pointers are in
`docs/workpackages/WP-52-reconciliation.md`; the post-release capability design is in
`docs/workpackages/WP-68-outstanding-capabilities-design.md`.

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
| 25 | Ads API write endpoints | merged | client capability only; WP-93 still needs the immutable approval and worker execution gateway |
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
| 54 | MCP production setup | merged and deployed | secured Evo container stack, Cloudflare Tunnel, two-client read/audit verification |
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
| 67 | Integration and release evidence | merged and deployed | release CI, hosted migrations, production web and MCP revision verified |

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
| 79 | SP-API profile binding and SQP scheduling | merged; live gated | exact profile/marketplace binding, Vault custody, LWA refresh and weekly due-work scheduling; hosted migration, tenant binding and live report parity remain gated |
| 80 | Web database pool HMR reuse | merged and deployed | one non-production pool survives Next.js route recompilation; the prior PostgreSQL client-exhaustion Playwright failure is covered by module-reload and full browser tests |
| 81 | Current release status reconciliation | merged | evidence-only baseline at `48b9625`; merge `d6a1e6b` |
| 82 | Quiet public application shell | merged and deployed | anonymous routes use the compact public frame and server-gate feedback controls; authenticated operator navigation is unchanged |
| 83 | SB Video contract probe | merged; live gated | non-persisting readers and count-only reconciliation prove documented shapes; no authorized live probe has run |
| 84 | Transactional SP report promotion | merged; live gated | complete-date replacement is wired for four SP report grains; live worker count review remains open |
| 85 | Observed SB Video ingestion | merged; hosted data gate open | current-snapshot ad/version-to-Asset-ID mapping and same-day fact gates are in the deployed code; hosted migration and live parity remain open |
| 86 | Contextual-negative review/export | review | open PR; analytics repair and ad-group proposal review remain separate from Amazon actions |
| 89 | Data context and filtered selection | merged and deployed | compact freshness context plus working filtered select/deselect behavior |
| 90 | Weekday preview schedule | review | open PR; profile-local weekdays schedule recommendation previews only |
| 91 | Live route performance | in-progress | Grid and Time Machine remain above the live targets recorded below |
| 93 | Guarded Amazon write policy | merged; runtime gated | manually approved writes are authorized only through immutable worker plans, allowlists, audit and resync; no general live mutation path exists |
| 96 | Guarded Sponsored Products write gateway | review; contract and adapter superseded | WP-179 and WP-180 replace the stale PR's shared-contract and provider-adapter portions; persistence and worker slices remain unmerged and all runtime gates remain closed |
| 110 | Focused operator navigation | merged and deployed | task-oriented groups and quiet utility footer |
| 112 | Release-artifact checks | review | open PR; exact distinctive runtime artifacts still need reconciliation |
| 113 | OpenSpell MCP connection name | merged and deployed in web | setup snippets use `openspell`; stable environment-variable and package identifiers remain unchanged |
| 114 | Date-range browser gate | merged | Dashboard and Grid presets are covered in the authenticated suite |
| 116 | Hydration-safe E2E interactions | review | open PR awaiting exact-head reconciliation |
| 117 | Shared route acceptance | review | open PR awaiting exact-head reconciliation |
| 119 | Query Intelligence performance | merged | the synthetic 5,000-fact join improved from about 409 ms to 14 ms with semantic parity |
| 123 | Advertising API capability map | review | open PR; provider support must remain distinct from implemented and live-verified support |
| 124 | Multi-product campaign creation architecture | merged | guarded SP, SB, SB Video and SD resource graphs are designed; no creation runtime was added |
| 125 | Campaign creation contracts | merged; runtime gated | inactive plans, approvals, write-ahead evidence, deterministic accounting and observation-gated dependencies merged in `cd5c167`; no migration, provider call, worker executor or deployment was activated |
| 131 | Product budget-usage reads | merged | strict SP/SB/SD endpoint and indexed-response validation; worker integration remains deferred |
| 134 | Serverless database lifecycle | merged and deployed | bounded web connection reuse passed the production route sweep |
| 138 | Chart preference migration | merged and deployed | prior default presentations advance once without discarding genuine operator choices |
| 139 | Same-document navigation | merged and deployed | routine operator transitions preserve the application document |
| 140 | Time Machine windowing | merged and deployed | stable keyset history windows bound initial rendering; live latency remains open |
| 141 | Optimizer campaign windowing | merged and deployed | campaigns are visible in bounded pages; server query/payload work remains separate |
| 142 | Grid data boundary | merged and deployed | authenticated, tenant-scoped, bounded row endpoint with exact counts and race protection |
| 143 | Experiment scope UX | merged and deployed | campaign-name selection, profile isolation, optional scope and filtered select-all are live |
| 144 | Public-runner CI reliability | merged | database test concurrency is bounded without weakening the gate |
| 145 | OpenSpell repository policy | merged | public-repository and 1Password boundaries align with the current product name |
| 147 | Marketing Stream correctness recovery | in-progress | signed revisions, settling, budget corrections, locking and subscription identity are under fresh-tree review |
| 148 | Live release evidence | in-progress | current revision, CI, deployment, authenticated QA and open gaps reconciled without runtime changes |
| 179 | Guarded SP write contracts | merged; runtime gated | inert update-plan, approval, fingerprint and bounded provider-result contracts merged in `4a0d91c` under `@wizard-ads/shared/sp-writes`; no job, migration, provider call, worker executor or deployment was activated |
| 180 | Guarded SP provider adapter | merged; runtime gated | complete observation, marketplace decimal conversion and one-attempt mutation semantics merged in `3d30f52` under `@wizard-ads/ads-api/sp-write-adapter`; no worker consumer, migration, deployment, provider grant or live mutation was activated |
| 181 | Unified Reporting dual-run | merged; runtime gated | default-off `spCampaigns` sidecar merged in `d75ec26` with explicit advertiser binding, a durable one-send create fence, bounded retrieval and a separate outcome ledger; Reporting v3 remains the sole fact and promotion authority, and no hosted migration, binding, deployment, activation or provider call followed |

## Milestone gates

- **v0 close:** OAuth and profile discovery; entity and campaign-fact sync on pilot profiles;
  minimal grid; generated goldens; recon specs. Current live satisfaction was not rechecked by
  WP-52.
- **v1 evidence criterion:** 14 consecutive verified crosscheck days on at least five pilot
  profiles; campaign-grain tolerance for at least 95% of spending campaigns over a week; explained
  optimizer parity spot-check. No current evidence closes this criterion; it gates scaled
  automation, while individual manually approved batches use the stricter WP-93 action gates.

## Dated live and deployed evidence

- On 2026-09-01 WP-181 merged at `d75ec26` after PR #91 exact-head run `33423728036` passed both
  jobs. Exact-main run `33424944462` passed both jobs on attempt 2; attempt 1 had one unrelated
  invitation redirect timing failure while the repository gate and WP-181 auth-role suite passed.
  Production web remains at `44da7ac`, 16 commits behind; production MCP remains at `b5c210d`, 156
  commits behind; the active legacy worker revision is unproven. No hosted migration, tenant
  binding, deployment, feature activation, provider call, download, fact write or Amazon mutation
  followed the merge.
- On 2026-08-31 PR #89 exact-head run `33401540530` and exact-main run `33402961215` passed both
  jobs before and after the inert Sponsored Products provider adapter merged at `3d30f52`.
  Production web remains at `44da7ac`, 13 commits behind; production MCP remains at `b5c210d`, 153
  commits behind; the worker revision is still unproven. No migration, deployment, provider grant
  or Amazon write was activated.
- On 2026-08-31 PR #88 exact-head run `33390222064` and exact-main run `33391341005` passed both
  jobs before and after the guarded Sponsored Products contracts merged at `4a0d91c`. Production
  web remains at `44da7ac`, seven commits behind; production MCP remains at `b5c210d`, 147 commits
  behind; the worker revision is still unproven. No write runtime was activated.
- On 2026-08-31 exact-main CI run `33377445361` passed both jobs at `cd5c167` after the inactive
  campaign-creation contracts merged. Production web remains at `44da7ac`, six commits behind;
  production MCP remains at `b5c210d`, 146 commits behind; the worker revision is still unproven.
- On 2026-08-31 exact-main CI run `33367903978` passed both jobs at `2154b5a`, including
  typecheck, lint, tests, hygiene, disposable migration verification, production web build, and
  Playwright. Production web still reports `44da7ac`, five commits behind that source; production
  MCP reports `b5c210d`, 145 commits behind, and the legacy worker has no exact revision stamp. The
  new report worker is absent. These runtimes are not one proven release.
- On 2026-08-30 the production web health endpoint reported exact revision
  `5e372c82361776070084e0265fea8c504a0d8781`, matching `origin/main`. GitHub Actions run
  `33298955347` passed typecheck, lint, tests, hygiene, migrations, build and the Playwright job
  for that exact revision before Vercel deployment `dpl_GMmrJzpg4B62e5aQsAiMpsC4BDFC` was
  promoted. The previous deployment remains available as a rollback anchor.
- The authenticated production pass opened Dashboard, Campaign Optimizer, Creative Performance,
  Query Intelligence, Dayparting, Time Machine and Connect AI without an application error. The
  experiment form loaded both approved test profiles; campaign-name selection and filtered
  select-all selected all 99 matching campaigns and clear restored zero without creating an
  experiment. Grid returned 3,616 exact real rows, kept one request and preserved nested grouping,
  reorder and removal behavior. No export or Amazon write was invoked and post-release logs showed
  no HTTP 5xx response.
- The public MCP health endpoint remains ready with database access at revision `b5c210d`. This is
  now explicit deployment drift from the web revision, so the earlier two-client MCP proof remains
  historical rather than proof for the current web release.

- The pre-release full-route production QA is `docs/design/QA-2026-08-27.md`. Its second round
  records the brand system, settling presentation, comparison-flow repairs, target bid columns,
  and Bugs/Roadmap split as live on that date.
- The MCP tunnel credential was rotated and the connector was restarted. On 2026-08-29 the public
  health endpoint returned HTTP 200 with database ready at application revision `b5c210d`. Codex
  and Claude Code each discovered the same 11 analytical tools, found no write-like tool, completed
  a permitted profile-list read and produced two recent audit records while advancing key
  last-used state. At that point MCP matched the deployed web revision and trailed current main
  while WP-85 remained migration and provider gated. Durable 1Password custody could not be
  verified from the available CLI session, so secret-manager reconciliation remains open. No
  mutation tool is exposed.
- Production was revision-stamped and verified at `bfce504` after the first release merge. The dashboard,
  campaign builder, 3,597-row nested grid, optimizer, recommendations, Time Machine, Sync Status
  and Connect AI routes completed an authenticated click-through without page, console or HTTP
  errors. The larger operator-workspace release at `c16022b` was then deployed successfully and
  returned HTTP 200 on the production custom domain. It was superseded before an authenticated
  click-through of that exact revision was recorded.
- GitHub CI run `33255581804` passed typecheck, lint, tests, hygiene, migrations, build and
  Playwright for exact main revision `b5c210d`. That revision was deployed from a clean worktree to
  Vercel deployment `dpl_7LsXivUy6XMqgYCtwagQZBEqCxrp`; Vercel reports ready and assigns the custom
  production domain. Anonymous `/login` returns HTTP 200 without the feedback control, while an
  anonymous `/dashboard` request redirects to `/login`.
- Exact-main CI run `33256509372` passed both jobs after WP-85 merged at `fc254bc`. At that
  checkpoint no WP-85 migration or deployment had followed: production web and MCP remained at
  `b5c210d` pending the hosted schema and live provider gates. The later web deployment is recorded
  above; MCP still remains on that revision.
- The hosted migration ledger contains the operator-intelligence foundation followed by Time
  Machine v2. Both exact tracked files were hash-checked before application; all new tables retain
  tenant RLS.
- The authenticated normal Chrome session reloaded the dashboard with the feedback control present
  and no application error. A post-deploy pass covered 21 of 21 routes with HTTP 200 and no page
  error. First loads of Grid (4.27 seconds) and Time Machine (5.36 seconds) remain measured
  performance gaps rather than functional failures. No competitor data or dashboard configuration
  was changed.

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
- A default-off Unified Reporting request-status sidecar now exists for `spCampaigns`, but provider
  downloads, fact equivalence, promotion, maximum-history bootstrap and a live-verified coverage
  matrix remain absent. Stale-row reconciliation still applies only to accepted complete SP report
  dates, with Reporting v3 as the sole promotion authority.

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
  group's facts to one guessed asset. The runtime is deployed but remains inactive for this source;
  the required hosted migrations and live count crosscheck have not occurred.
- SQP now has strict Sunday-Saturday planning, one-marketplace requests, canonical ASIN batching,
  resumable exact-identity checkpoints, provider report-ID reuse across retry/process restart,
  pending-result deferral without failure-budget consumption, strict document parsing, counted
  transactional replacement, vocabulary approval preservation, spend-conserving PPC joins and
  routing-gated review proposals. Overlapping promotions take sorted per-ASIN transaction locks
  and reject stale evidence from an immutable source-report freshness ledger before deletion. The
  WP-79 adds an exact advertising-profile/marketplace to SP-API account binding, service-role-only
  Vault custody, LWA token caching and one-time unauthorized retry, counted active advertised-ASIN
  selection, and a weekly due-work scheduler. Live execution remains gated on applying its additive
  migration, configuring the deployment-owned LWA application and app role, creating tenant bindings, and
  proving count parity with one real read-only report.
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
- Creative Performance, Query Intelligence, Dayparting and Strategy Overview are now guarded,
  task-navigation-accessible operator surfaces. Empty or incomplete sources remain visible as
  source gates instead of demo performance.
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
- Loading speed is an open priority acceptance gap. On the current live revision Grid first became
  usable in 6.79 seconds cold and 6.10 seconds warm; Time Machine loaded in 4.21 seconds. Grid's
  isolated 3,597-row reference run completed in 1.53 seconds and the shared hosted runner in 2.83
  seconds, but neither substitutes for production. A live three-level grouping interaction measured
  about 155 ms including browser automation overhead, so the p95 below-150-ms gate is not closed.
- Hosted SQP configuration and the SB Video provider adapter remain open. The new product surfaces are complete for
  stored evidence, but cannot establish live Amazon parity until those adapters produce counted,
  authoritative rows. WP-83 proves the documented `adId`, nested creative, Asset-ID and `sbAds`
  shapes without persistence; WP-85 implements the current-snapshot `adId + creativeVersion`
  observation model without inventing `creativeId`. Its hosted migrations, deployment and an
  authorized live count probe remain required, and the snapshot does not establish historical
  mapping authority. Ad-group performance must never be guessed onto one asset. Time Machine v2 is
  hosted and deployed, but a live reversion cannot be end-to-end verified until an eligible export
  batch exists.
- Optimization-group free-text exclusions are explicitly reference metadata. Typed, enforceable
  exclusion rules remain a separate contract/work package rather than silently matching names.

## Release gates

- [x] GitHub CI succeeded for the first exact deployed main revision `bfce504`.
- [x] Hosted typecheck, lint, test, hygiene, migration and 54-workflow Playwright gates passed
      independently for WP-75, WP-76 and WP-77 before merge.
- [x] Final review-branch `pnpm check` after the last integration commit. The root test runner now
      executes the unchanged UI frame-budget suite after the other Turbo packages; the complete
      isolated UI suite passed 149 of 149 instead of measuring unrelated CPU contention.
- [x] Additive migration, RLS, report promotion, roadmap, creative persistence and dayparting
      persistence suites executed against disposable PostgreSQL with synthetic fixtures. The final
      database package run passed 26 files and 204 tests; the worker package passed 18 files and
      163 tests against the same disposable database. The MCP package passed 55 tests with scoped,
      expiring issuance and unsafe-legacy-key refusal.
- [x] Workspace build passed; the web build generated the current route tree without production
      environment values.
- [x] Exact deployed revisions for web and always-on MCP service at `bfce504`.
- [x] Full hosted PR gate passed for the WP-80 implementation tree: typecheck, lint, tests and
      hygiene completed in 5m33s; serial Playwright completed in 12m42s. Exact merge-main run
      `33248703627` also completed successfully at `48b9625`.
- [x] Exact-main CI run `33255581804` passed both jobs at `b5c210d`; that web tree is deployed and
      ready on the custom production domain.
- [x] Public MCP restored after tunnel-credential rotation; both clients repeated tool discovery,
      one real read, audit-log and last-used checks with no write-like tool exposed at `b5c210d`.
- [x] Exact-main CI run `33256509372` passed both jobs at repository revision `fc254bc`.
- [x] Exact-main CI run `33298955347` passed both jobs at `5e372c8`; the production web health
      endpoint reports that exact revision after authenticated candidate QA and promotion.
- [x] Exact-main CI run `33367903978` passed both jobs at repository revision `2154b5a`.
- [x] Exact-main CI run `33377445361` passed both jobs at repository revision `cd5c167`.
- [x] PR #88 exact-head CI run `33390222064` and exact-main run `33391341005` passed both jobs at
      `41f447f` and merged revision `4a0d91c`, respectively.
- [x] PR #91 exact-head CI run `33423728036` and exact-main run `33424944462` attempt 2 passed both
      jobs at `d343a81` and merged revision `d75ec26`, respectively.
- [ ] Keep the explicit deployment drift: production web is at `44da7ac`, MCP remains at
      `b5c210d`, and the active worker revision is unproven. WP-85 and WP-181 hosted data gates and
      attended read-only migration reconciliation remain open.
- [x] Hosted ledger verified for the two newly authorized additive migrations.
- [ ] Live coverage matrix and source precedence verified without client data entering Git.
- [x] Full authenticated Wizard Ads route/state click-through at `bfce504`.
- [x] Authenticated click-through at `b5c210d`: 21 of 21 production routes returned HTTP 200 with
      no application error; live first-load performance gaps remain recorded separately.
- [x] Authenticated click-through at `5e372c8`: core operator and intelligence routes opened
      without an application error, Grid returned exact counted rows, experiment filtered
      select-all worked across profile changes, and no post-release 5xx or Amazon write occurred.
- [x] Local Playwright release suites: 27 production-build workflows and 27 authenticated-dev
      workflows passed, including dashboard, nested grid, campaign export, recommendations,
      experiments, Time Machine, tenancy, OAuth safety and every guarded route.
- [ ] Fresh AdLabs and SYNQ workflow comparison. AdLabs has a durable redacted baseline in
      `tools/recon`; SYNQ has no tracked workflow evidence.
- [x] Release-candidate PostgreSQL suites: database 209, worker 179 and web 316 tests passed with
      migrations and synthetic tenant fixtures. The UI 3,597-row performance suite remained green.
- [x] Release-candidate Playwright: 27 production-build workflows and 27 authenticated-dev
      workflows passed, including every new intelligence route and anonymous redirects.
- [ ] Apply `20260829140000_feature_job_types.sql` and
      `20260829150000_spapi_profile_bindings.sql` only after exact hosted authorization. SQS and
      weekly SQP provider execution remain disabled without their deployment configuration, so
      deploying code first is safe.
- [ ] Apply `20260829160000_sb_video_report_type.sql` and
      `20260829160100_sb_video_observed_ingestion.sql` only after exact hosted authorization, then
      activate the already-deployed WP-85 path and prove mapping/fact counts with an authorized
      read-only profile.
- [ ] Apply `20260830170000_marketing_stream_correctness.sql`, PR #81's
      `20260830180000_optimization_weekday_schedules.sql`, and
      `20260831100000_unified_reporting_dual_run.sql` only after ledger reconciliation and exact
      hosted authorization. Keep the Unified sidecar off until its binding, deployment revision,
      consumer ownership and one authorized read-only cohort are proven.
- [ ] Run the authorized, non-persisting SB Video probe and review one read-only SP report per
      supported grain with source, promoted, superseded and canonical counts.
- [ ] v1 crosscheck exit gate: consecutive verified days, campaign-grain parity, and explained
      optimizer spot-check.
