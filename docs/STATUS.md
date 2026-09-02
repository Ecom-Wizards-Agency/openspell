# OpenSpell — program status board

Manager: Fable. States: `todo` · `in-progress` · `review` · `merged` · `gated` · `superseded`.

Source and deployment headers reconciled 2026-09-02 against `origin/main` at `857ce0c`. The
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
| 79 | SP-API profile binding and SQP scheduling | merged; live gated | exact profile/marketplace binding, Vault custody, LWA refresh and weekly due-work scheduling; hosted schema is present, while tenant binding, deployment configuration and live report parity remain gated |
| 80 | Web database pool HMR reuse | merged and deployed | one non-production pool survives Next.js route recompilation; the prior PostgreSQL client-exhaustion Playwright failure is covered by module-reload and full browser tests |
| 81 | Current release status reconciliation | merged | evidence-only baseline at `48b9625`; merge `d6a1e6b` |
| 82 | Quiet public application shell | merged and deployed | anonymous routes use the compact public frame and server-gate feedback controls; authenticated operator navigation is unchanged |
| 83 | SB Video contract probe | merged; live gated | non-persisting readers and count-only reconciliation prove documented shapes; no authorized live probe has run |
| 84 | Transactional SP report promotion | merged; live gated | complete-date replacement is wired for four SP report grains; live worker count review remains open |
| 85 | Observed SB Video ingestion | merged; activation gated | current-snapshot ad/version-to-Asset-ID mapping and same-day fact gates are in the deployed code; hosted migrations are present, while revision-matched activation and live parity remain open |
| 86 | Contextual-negative review/export | superseded | stale PR #17 was rebuilt on current main as WP-182 and closed |
| 89 | Data context and filtered selection | merged and deployed | compact freshness context plus working filtered select/deselect behavior |
| 90 | Weekday preview schedule | superseded | PR #40 was closed; WP-171 is the merged replacement |
| 91 | Live route performance | in-progress | Grid and Time Machine remain above the live targets recorded below |
| 93 | Guarded Amazon write policy | merged; runtime gated | manually approved writes are authorized only through immutable worker plans, allowlists, audit and resync; no general live mutation path exists |
| 96 | Guarded Sponsored Products write gateway | superseded | PR #24 was closed unmerged at archival head `78e718b` after WP-191 accepted its remaining token-fenced ownership/recovery lesson on current main; no stale source was rebased, cherry-picked or merged |
| 110 | Focused operator navigation | merged and deployed | task-oriented groups and quiet utility footer |
| 112 | Release-artifact checks | superseded | stale PR #35 was closed after WP-184 preserved and strengthened its distinct requirements |
| 113 | OpenSpell MCP connection name | merged and deployed in web | setup snippets use `openspell`; stable environment-variable and package identifiers remain unchanged |
| 114 | Date-range browser gate | merged | Dashboard and Grid presets are covered in the authenticated suite |
| 116 | Hydration-safe E2E interactions | merged | exact interaction-readiness assertions merged through PR #38 at `4c95778` |
| 117 | Shared route acceptance | merged | shared date/profile route acceptance merged through PR #39 at `03d63ec` |
| 119 | Query Intelligence performance | merged | the synthetic 5,000-fact join improved from about 409 ms to 14 ms with semantic parity |
| 123 | Advertising API capability map | merged | capability/support distinctions merged through PR #41 at `97ce0ba`; live verification remains separate |
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
| 147 | Marketing Stream correctness recovery | merged; runtime gated | signed revisions, settling, budget corrections, locking and subscription identity merged through PR #64 at `49c35d9`; hosted migration is present and the live subscription remains open |
| 148 | Live release evidence | merged | source, CI, deployment, authenticated QA and open gaps were reconciled through PR #59 at `d7beb71`; later drift is recorded below |
| 171 | Weekday preview schedules | merged; deployment gated | merged through PR #81 at `8a4bd0a`; hosted migration, aggregate-only data postflight, exact-head CI and exact-main CI are proven, while revision-matched worker/web deployment and QA remain open |
| 179 | Guarded SP write contracts | merged; runtime gated | inert update-plan, approval, fingerprint and bounded provider-result contracts merged in `4a0d91c` under `@wizard-ads/shared/sp-writes`; no job, migration, provider call, worker executor or deployment was activated |
| 180 | Guarded SP provider adapter | merged; runtime gated | complete observation, marketplace decimal conversion and one-attempt mutation semantics merged in `3d30f52` under `@wizard-ads/ads-api/sp-write-adapter`; no worker consumer, migration, deployment, provider grant or live mutation was activated |
| 181 | Unified Reporting dual-run | merged; runtime gated | default-off `spCampaigns` sidecar merged in `d75ec26` with explicit advertiser binding, a durable one-send create fence, bounded retrieval and a separate outcome ledger; its hosted migration is present, while binding, deployment and activation remain open; Reporting v3 remains sole fact and promotion authority |
| 182 | Contextual-negative review/export | merged; deployment gated | complete bounded review, audit-backed decisions, review-preserving refresh and immutable exact-byte JSON/CSV evidence merged in `5d36457`; its hosted migration is present, no Amazon action path exists, and matching web deployment remains open |
| 183 | Calendar-boundary fixture reliability | merged; test-only | tenant fixtures now open their current and preceding fact months, with SQP-crossing and Sunday-month-start regressions; merged in `6d182e6` without a migration or hosted data change |
| 184 | Distinctive release evidence | merged; deployment gated | exact Vercel revision authority, official-SVG bytes, rendered Grid/Recommendations capabilities, locked GET-only transport and deterministic non-authorizing evidence merged in `c7a141a`; no candidate was deployed, verified or promoted |
| 185 | Hosted migration lock safety | merged; source guard | five-second transaction-scoped lock waits and source enforcement merged in `7276d8d`; the four guarded pending files were subsequently applied through the attended operator path |
| 186 | Authenticated relation privileges | merged and hosted | corrected exact public-root, column, partition, sequence and creator-default matrices plus upgrade/concurrency proofs merged through PR #102 at `85e9a1d`; the sole forward migration is ledger row 41 with all 27 statements and passed attended production postflight |
| 187 | Guarded SP write persistence ledger | merged; source-only | default-empty immutable evidence, exact authority/version snapshots, single-winner reservation, result/recovery closure, derived accounting and tenant-safe purge proofs merged through PR #104 at `be2b7bd`; exact-head and exact-main CI passed, while the migration was not hosted and no job, worker, provider call, deployment or live mutation was activated |
| 188 | Guarded SP write query facade | merged; source-only | explicit staging/runtime database capabilities, committed single-winner dispatch tickets, controlled refusal/error mapping and exact evidence/accounting verification merged through PR #106 at `5fc9471`; exact-head and exact-main CI passed, while no migration, job, worker/provider reachability, deployment setting or live mutation was activated |
| 189 | Worker claim-loop resilience | merged; deployment gated | direct claim-RPC `57014` containment, capped equal-jitter backoff, single-flight one-shot lifecycle, active-claim shutdown draining and sanitized health merged through PR #108 at `882a229`; real PostgreSQL proves canceled-claim rollback and exactly-once later completion, while no migration, job type, queue owner, provider call, deployment or SP-write activation changed and the active legacy worker revision remains unproven |
| 190 | Auth guard process isolation | merged; test-only | the unchanged 69 browser tests run as 11 fresh serial processes with exact route-manifest conservation, crash-safe setup/cleanup, the explicit 4 GB heap cap, one worker and zero retries; merged through PR #110 at `1231342` after first-attempt exact-head and exact-main CI, with no application, authentication, migration, deployment or runtime change |
| 191 | Token-fenced SP outbox protocol architecture | merged; architecture only | private mutable custody heads plus immutable journals, typed non-JSON claim tokens, database-clock transitions, claim-bound dispatch-lease/reservation wrappers, exact closure/error outcomes and separate source/coordinator/activation packages were accepted through PR #113 at `8291158`; no migration, facade code, job, provider reachability, hosted schema, deployment or activation changed |
| 192 | Token-fenced SP outbox delivery | merged; source-only | private delivery heads and journals, opaque claim custody, exact renew/defer/complete transitions, claim-bound dispatch-lease/provider-reservation wrappers, tokenless grant revocation and purge/lock-order proofs merged through PR #115 at `dbc788a`; exact-head and exact-main CI passed, while both SP migrations remain unhosted and no app, job, provider reachability, deployment or activation changed |
| 193 | Report-worker stage readiness | merged; staging gated | clean-checkout frozen installation, CI deployment-harness enforcement, no-overlap report ownership transfer, unknown-outcome quarantine and schema-compatible rollback merged through PR #117 at `8996706`; corrected exact-head and exact-main CI passed, while no release was staged, no service or queue ownership changed and no provider, database or production action ran |
| 194 | Fail-closed report claim custody | merged; source-only | one-way legacy-to-fenced report authority, opaque claim transitions, ambiguity quarantine, bounded report parsing/final audit and revision-pinned deployment rollback merged through PR #119 at `3e1f391`; exact-head and exact-main CI passed, while its migration remains unhosted and no service, queue owner, provider or production state changed |
| 195 | Campaign-scoped optimizer previews | merged; deployment gated | AdLabs-style campaign checkboxes, explicit all-versus-selected scope, immutable per-group/unassigned child runs, exact queue custody and bounded parent polling merged through PR #121 at `857ce0c`; corrected exact-head and exact-main CI passed, while its migration is unhosted and no compatible worker/web revision, provider call or Amazon mutation is live |

## Milestone gates

- **v0 close:** OAuth and profile discovery; entity and campaign-fact sync on pilot profiles;
  minimal grid; generated goldens; recon specs. Current live satisfaction was not rechecked by
  WP-52.
- **v1 evidence criterion:** 14 consecutive verified crosscheck days on at least five pilot
  profiles; campaign-grain tolerance for at least 95% of spending campaigns over a week; explained
  optimizer parity spot-check. No current evidence closes this criterion; it gates scaled
  automation, while individual manually approved batches use the stricter WP-93 action gates.

## Dated live and deployed evidence

- On 2026-09-02 PR #121 merged WP-195 campaign-scoped optimizer previews at `857ce0c` after
  corrected exact-head run `33645864956` passed both jobs at `8f63b95`; exact-main run
  `33647461569` then passed both jobs at the merge revision. The first exact-head browser run
  `33643931073` exposed a stale one-job fixture assertion after WP-195 correctly added inert preview
  custody evidence; the corrected test proves the exact fixture-profile and job-type columns. High
  correctness, Extra-High adversarial and scope-safety reviews ended with no blocker, high or
  medium defect. Serialized local verification passed database 434, worker 451 and web 643 tests;
  UI functional and CI-threshold performance tests passed 163 and 10, and focused optimizer
  Playwright passed. The hosted ledger remained at 41 versions through `20260901010000`; production
  web remained `44da7ac`, MCP remained `b5c210d`, the legacy worker remained active and the new
  report-worker unit remained absent. No migration, deployment, provider call or Amazon mutation
  occurred.
- On 2026-09-02 PR #119 merged WP-194 fail-closed report custody at `3e1f391` after exact-head run
  `33626943610` passed both jobs at `3e61a42`; exact-main run `33628287979` then passed both jobs at
  the merge revision. High correctness and Extra-High adversarial reviews found no blocker, high or
  medium defect. Serialized local verification passed database 431, worker 439 and web 615 tests;
  the UI passed 163 functional and 10 CI-threshold performance tests. The hosted ledger remained at
  41 versions, the report-worker unit remained absent, the legacy worker remained active, and no
  migration, deployment, queue-owner transfer, provider call or production mutation occurred.
- On 2026-09-02 PR #117 merged WP-193 report-worker stage readiness at `8996706` after corrected
  exact-head run `33595023515` passed both jobs at `36cfbfe`; exact-main run `33596330244` then
  passed both jobs at the merge revision. The first exact-head run `33594716502` made the new
  clean-runner deployment gate fail because `ripgrep` was absent; the corrected head installs that
  prerequisite explicitly. High correctness and Extra-High adversarial reviews ended with no
  finding. The package staged no release, changed no service, consumer, queue, hosted schema,
  deployment or production data, and made no provider call.
- On 2026-09-02 PR #115 merged the inert WP-192 token-fenced SP outbox delivery implementation at
  `dbc788a` after exact-head run `33590334260` passed both jobs at `d1e09a9`; exact-main run
  `33591051237` then passed both jobs at the merge revision. High correctness and Extra-High
  adversarial reviews reported no blocker, high or medium finding. The focused facade/blast set
  passed 25 tests, focused migration/integration passed 21, and the serialized database package
  passed 421. Migration SHA-256
  `c34fc0a1902abe27f0c33d66c1a083fb32f0fd5df30974baecace674a2219a2c` remains source-only. No
  hosted apply, app/job/provider path, deployment, restart, feature activation or Amazon mutation
  occurred.
- On 2026-09-02 PR #113 merged WP-191's architecture-only token-fenced SP outbox protocol at
  `8291158` after exact-head run `33582983015` passed both jobs at `fd47827`; exact-main run
  `33583810523` then passed both jobs on its first attempt. High correctness and Extra-High
  adversarial reviews reported no blocker, high or medium finding. PR #24 was then closed unmerged
  because its remaining ownership lesson has a durable current-main home. No migration, hosted
  apply, app/job/provider path, deployment, restart, feature activation or Amazon mutation occurred.
- On 2026-09-02 PR #111 merged a one-line, test-only database timeout budget at `2ea10e1` after
  exact-head run `33576253788` passed both jobs at `9330305`; exact-main run `33576320746` then
  passed both jobs on its first attempt. The change preserved every assertion, SQL statement,
  cleanup path and retry policy while giving the existing second disposable-database setup the
  same 60-second budget already used by neighboring database lifecycle tests.
- On 2026-09-02 PR #110 merged WP-190 auth-guard process isolation at `1231342` after exact-head
  run `33577280436` passed both jobs at `adf410b`; exact-main run `33578277240` then passed both
  jobs on its first attempt. All 69 browser tests remain conserved across 11 named fresh serial
  processes with the explicit 4 GB cap, one worker and zero retries. High correctness and
  Extra-High lifecycle/adversarial reviews found no blocker, high or medium defect. No application
  behavior, authentication rule, migration, deployment, restart, provider call or runtime
  activation changed.
- On 2026-09-02 PR #108 merged WP-189 worker claim-loop resilience at `882a229` after exact-head
  run `33565270705` passed both jobs at `7e6aec6`. In exact-main run `33566330881`, the repository
  job passed on attempt 1 and Playwright passed all 69 tests on a clean full-job rerun at the merge
  revision. Its first Playwright attempt exhausted the auth shard's explicit 4 GB Next.js heap after
  the signed-in route sweep; the following 404 received an empty response because that server had
  aborted. The merge and implementation trees were identical, exact-head had already passed all 69
  browser tests, the rerun passed all 69 from scratch with retries disabled, and an independent
  review found no WP-189 regression. High correctness and Extra-High adversarial reviews found no
  blocker, high or medium implementation defect. Focused
  worker tests passed 35 tests; full worker and database suites each passed 396 tests on disposable
  PostgreSQL; production build and all nine local Playwright partitions passed. No migration,
  deployment, restart, provider call, queue-ownership transfer or SP write was performed. WP-190
  subsequently resolved the browser heap-margin follow-up without changing this implementation.
- On 2026-09-02 PR #106 merged the inert WP-188 Sponsored Products write query facade at
  `5fc9471` after exact-head run `33555304056` passed both jobs at `20fe1ab`; exact-main run
  `33556738961` then passed both jobs on the merge. Focused facade proofs passed 21 tests, the
  existing ledger and migration-safety set passed 51 tests, and High correctness plus Extra-High
  adversarial reviews reported no blocker, high or medium finding. The facade adds no job type,
  worker/provider consumer, deployment variable or activation; the underlying WP-187 migration
  remains unhosted and no Amazon mutation occurred.
- On 2026-09-02 PR #104 merged the inert WP-187 Sponsored Products write-persistence ledger at
  `be2b7bd` after exact-head run `33540942307` passed both jobs at `f4f0070`; exact-main run
  `33542410285` then passed both jobs on the merge. High correctness and Extra-High adversarial
  reviews both reported no blocker, high or medium finding. The source migration remains unhosted,
  its installed state is default-empty, and no job type, queue claimant, worker consumer, provider
  call, deployment variable or live mutation path was activated.
- During the same 2026-09-02 reconciliation, the legacy integration worker exited once on an
  uncaught `claimSyncJobs` statement timeout. The operator then completed an attended stop/start
  and observed `NRestarts=0`; final read-only reconciliation found the service active/running with
  a new process and `NRestarts=1` again. The unprivileged journal exposed no cause for that latest
  restart. WP-189 contains direct claim-RPC `57014` failures in source, but the active service
  revision remains unproven, so its protection is not yet live evidence.
- On 2026-09-01 PR #81 merged WP-171 at `8a4bd0a` after exact-head run `33500087803`; exact-main
  run `33501292698` passed both jobs. Corrected WP-186 then merged through PR #102 at `85e9a1d`
  after exact-head run `33509780625`; exact-main run `33511203991` passed both jobs. The attended
  WP-186 window stopped the legacy worker, paused only the partition and retention cron jobs, and
  captured 77 roots, seven sequences, 230 partitions, 157 policies, 1,578,190 rows, exact platform
  and non-target ACL fingerprints, zero schema-capable transactions and zero blocking or exclusive
  locks. The exact migration SHA-256 was
  `db3def960f433c1e221c0257aacd3551e8c7b023fd178a078831ba2a038b7e2c`; the ledger now has 41
  versions through `20260901010000` and stores all 27 WP-186 statements. Postflight proved exact
  direct/effective table, column, partition, sequence and default authority, unchanged rows,
  policies, partitions, platform defaults, non-target ACLs and queue aggregates, and zero
  `postgres` target defaults. Both cron jobs were restored exactly; the legacy worker was manually
  restarted, reconnected and retained `NRestarts=0`, with no blocking or long-running query.
  Production web remains `44da7ac`, 48 commits behind; MCP remains `b5c210d`, 188 commits behind
  with the legacy service identity; the new report worker remains absent and the legacy worker has
  no revision stamp. No deployment, feature activation, provider call or Amazon mutation followed.
- On 2026-09-01 WP-184 merged at `c7a141a` after PR #97 exact-head run `33466339339`
  passed both jobs at corrected head `de0eee7`; exact-main run `33467035459` then passed both jobs,
  including migration replay, the production web build and all 68 serial browser tests. Production
  web remains at `44da7ac`, 27 commits behind; production MCP remains at `b5c210d`, 167 commits
  behind and still exposes the legacy service shape; the worker revision remains unproven. WP-184
  performed no hosted migration, deployment, promotion, provider write, credential retrieval or
  Amazon action. Its source verifier is therefore not yet a live product-release claim.
- On 2026-09-01 WP-182 merged at `5d36457` after PR #93 exact-head run `33445328649`
  passed both jobs on attempt 2; attempt 1 had one unrelated invitation redirect timing failure.
  Exact-main run `33447338899` then exposed a pre-existing Next dev HMR `networkidle` wait after its
  required redirect artifacts rendered. The isolated PR #94 repair merged at `eee6923`; exact-head
  run `33449128504` and exact-main run `33449983074` passed both jobs on their first attempts.
  The closeout run then exposed a fresh-database prior-month partition gap after crossing into
  September. Test-only PR #96 merged the fixture repair at `6d182e6`; exact-head run `33454770170`
  and exact-main run `33455623011` passed both jobs on their first attempts. Production web remains
  at `44da7ac`, 21 commits behind; production MCP remains at `b5c210d`, 161 commits behind; the
  active legacy worker revision is unproven. WP-182 and its closeout performed no hosted migration,
  deployment, provider call, feature activation or Amazon mutation. Its migration was applied later
  in the attended four-file push recorded above.
- On 2026-09-01 WP-181 merged at `d75ec26` after PR #91 exact-head run `33423728036` passed both
  jobs. Exact-main run `33424944462` passed both jobs on attempt 2; attempt 1 had one unrelated
  invitation redirect timing failure while the repository gate and WP-181 auth-role suite passed.
  Production web remains at `44da7ac`, 16 commits behind; production MCP remains at `b5c210d`, 156
  commits behind; the active legacy worker revision is unproven. PR #91 and this reconciliation
  performed no hosted migration, tenant binding, deployment, feature activation, provider call,
  download, fact write or Amazon mutation. Its migration was applied later; bindings remain
  unverified.
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
  group's facts to one guessed asset. The hosted migrations are present, but activation and the live
  count crosscheck have not occurred; deployed web and worker revision coherence remains unproven.
- SQP now has strict Sunday-Saturday planning, one-marketplace requests, canonical ASIN batching,
  resumable exact-identity checkpoints, provider report-ID reuse across retry/process restart,
  pending-result deferral without failure-budget consumption, strict document parsing, counted
  transactional replacement, vocabulary approval preservation, spend-conserving PPC joins and
  routing-gated review proposals. Overlapping promotions take sorted per-ASIN transaction locks
  and reject stale evidence from an immutable source-report freshness ledger before deletion.
  WP-182 adds a complete 5,000-row/8-MiB review boundary, explicit accept/dismiss/reopen decisions,
  review-preserving refresh, immutable exact-byte JSON/CSV artifacts, and exact audit/count/hash
  linkage. Export remains evidence only and explicitly records that Amazon was not updated. WP-79
  adds an exact advertising-profile/marketplace to SP-API account binding, service-role-only Vault
  custody, LWA token caching and one-time unauthorized retry, counted active advertised-ASIN
  selection, and a weekly due-work scheduler. Its hosted schema is present. Live execution remains
  gated on configuring the deployment-owned LWA application and app role, creating tenant bindings,
  deploying a matching revision, and proving count parity with one real read-only report.
- Dayparting now has an append-only revision ledger, exact-source stale guards, normalized SP/SB/SD
  hourly facts, DST-local derivation, settling/revised states, confidence-shrunk proposals and
  CSV/JSON serialization. The optional SQS consumer uses the standard AWS credential chain,
  retains valid raw events when modelling policy is absent, acknowledges only after counted
  projection, and keeps retry/health details sanitized. Its correctness migration is hosted, but no
  live subscription has been provisioned.
- The pure optimizer evidence engine covers synchronization conflicts, incomplete observation,
  insufficient evidence, supported lift and exact pre-change reversion. The worker reconciler
  links one export row to synchronized bid history and starts matched evaluation on the next full
  profile-local day. Group scheduling and persistence refuse overlapping previews and hold after
  export until the latest observation is complete with a `continue` decision. Tenant strategy
  supplies the evidence policy without source defaults; `hold` and `revert` remain review gates.
- WP-195 adds source-only native campaign checkboxes, filtered cross-page selection, exact
  all-versus-selected counts, immutable eligible-campaign scope and policy snapshots, one parent
  preview with per-group/unassigned children, exact queue-job custody and bounded non-overlapping
  polling. The hosted schema, exclusive WP-195-compatible recommendation claimant and
  revision-matched web remain gated, so the live optimizer still does not expose this behavior and
  no Amazon action path exists.
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
  observation model without inventing `creativeId`. Its hosted migrations are present; a
  revision-matched activation and authorized live count probe remain required, and the snapshot
  does not establish historical mapping authority. Ad-group performance must never be guessed onto
  one asset. Time Machine v2 is
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
- [x] PR #93 exact-head CI run `33445328649` attempt 2 passed both jobs at `8da15d9`; the isolated
      HMR synchronization repair passed PR #94 run `33449128504` at `97d8700`, and exact-main run
      `33449983074` passed both jobs at `eee6923` on its first attempt.
- [x] PR #96 exact-head CI run `33454770170` and exact-main run `33455623011` passed both jobs at
      `c5f79ca` and merged revision `6d182e6`, respectively, on their first attempts.
- [x] PR #97 exact-head CI run `33466339339` and exact-main run `33467035459` passed both jobs at
      corrected head `de0eee7` and merged revision `c7a141a`, respectively. The exact-main browser
      job passed all 68 tests.
- [x] PR #99 exact-head CI run `33474097617` and exact-main run `33474963275` passed both jobs at
      `1afd642` and merged revision `7276d8d`, respectively.
- [x] PR #100 exact-head CI run `33492048378` and exact-main run `33493274146` passed both jobs at
      `5a3ea64` and merged revision `5608849`, respectively.
- [x] PR #81 exact-head CI run `33500087803` and exact-main run `33501292698` passed both jobs at
      corrected head `ece43ac` and merged revision `8a4bd0a`, respectively.
- [x] PR #102 exact-head CI run `33509780625` and exact-main run `33511203991` passed both jobs at
      corrected head `fb9e693` and merged revision `85e9a1d`, respectively.
- [x] PR #104 exact-head CI run `33540942307` and exact-main run `33542410285` passed both jobs at
      `f4f0070` and merged revision `be2b7bd`, respectively.
- [x] PR #106 exact-head CI run `33555304056` and exact-main run `33556738961` passed both jobs at
      `20fe1ab` and merged revision `5fc9471`, respectively.
- [x] PR #108 exact-head CI run `33565270705` passed both jobs at `7e6aec6`; exact-main run
      `33566330881` passed the repository job on attempt 1 and Playwright on a clean full-job rerun
      at merged revision `882a229` after the first browser attempt exhausted the unchanged auth
      shard's Next.js heap.
- [x] PR #111 exact-head CI run `33576253788` and exact-main run `33576320746` passed both jobs at
      `9330305` and merged revision `2ea10e1`, respectively, on their first attempts.
- [x] PR #110 exact-head CI run `33577280436` and exact-main run `33578277240` passed both jobs at
      `adf410b` and merged revision `1231342`, respectively, on their first attempts; both browser
      jobs passed all 69 tests across 11 fresh serial processes.
- [x] PR #113 exact-head CI run `33582983015` and exact-main run `33583810523` passed both jobs at
      `fd47827` and merged revision `8291158`, respectively, on their first attempts. High and
      Extra-High reviews found no blocker, high or medium architecture defect.
- [x] PR #115 exact-head CI run `33590334260` and exact-main run `33591051237` passed both jobs at
      `d1e09a9` and merged revision `dbc788a`, respectively. High and Extra-High reviews found no
      blocker, high or medium implementation defect.
- [x] PR #117 corrected exact-head CI run `33595023515` and exact-main run `33596330244` passed both
      jobs at `36cfbfe` and merged revision `8996706`, respectively. High and Extra-High reviews
      ended with no finding.
- [x] PR #119 exact-head CI run `33626943610` and exact-main run `33628287979` passed both jobs at
      `3e61a42` and merged revision `3e1f391`, respectively. High and Extra-High reviews found no
      blocker, high or medium defect.
- [x] PR #121 corrected exact-head CI run `33645864956` and exact-main run `33647461569` passed both
      jobs at `8f63b95` and merged revision `857ce0c`, respectively. The first exact-head browser
      run exposed and led to correction of a stale fixture cardinality assertion; High,
      Extra-High and scope-safety reviews ended with no blocker, high or medium defect.
- [ ] Keep the explicit deployment drift: production web is at `44da7ac`, MCP remains at
      `b5c210d` (116 and 256 WP-195-source commits behind, respectively), the new report worker is
      absent, and the active legacy worker revision is unproven. The attended stop/start reset its
      restart counter to zero; the worker is active/running and now reports one later automatic
      restart whose cause the unprivileged journal does not expose. Claim-failure containment is
      merged source only; revision-matched deployment, activation and live-data parity gates remain
      open.
- [x] Hosted ledger verified for 41 migration versions through `20260901010000`, including the
      feature, SP-API, SB Video, Marketing Stream, WP-171, Unified Reporting,
      contextual-negative and WP-186 schema files. WP-186's exact 27-statement ledger, privilege,
      count, lock, queue and recovery postflight passed; schema presence does not complete the
      other features' separate runtime gates. WP-187's `20260901020000`, WP-192's
      `20260901030000`, WP-194's `20260901040000`, and WP-195's `20260901050000` migrations are
      merged source only; none is part of that hosted ledger.
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
- [x] WP-171 source is on main after fresh integration and exact-main CI.
- [ ] Keep optimizer edits and recommendation-job creation frozen until the exclusive recommendation
      claimant and web are revision-matched, WP-171-weekday-aware, WP-195-scope-compatible, deployed
      and verified. Keep every newly hosted feature disabled until its remaining binding, consumer,
      provider and counted parity gates pass.
- [x] Applied only `20260901010000_authenticated_relation_privilege_hardening.sql` from the
      ledger-compatible 41-file artifact after exact authorization and an exclusive DDL window;
      exact privilege, preserved-state, ledger, lock, queue, cron and worker-recovery postflight
      passed.
- [ ] Run the authorized, non-persisting SB Video probe and review one read-only SP report per
      supported grain with source, promoted, superseded and canonical counts.
- [ ] v1 crosscheck exit gate: consecutive verified days, campaign-grain parity, and explained
      optimizer spot-check.
