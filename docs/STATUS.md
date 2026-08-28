# wizard-ads — program status board

Manager: Fable. States: `todo` · `in-progress` · `review` · `merged` · `gated`.

Reconciled 2026-08-28 against `origin/main` at `602a780`. Here, **merged** means the
implementation is reachable from that revision. It does not mean deployed, applied to a hosted
database, live-data verified, or accepted by an operator. Full evidence and source pointers:
`docs/workpackages/WP-52-reconciliation.md`.

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
- That record also says the MCP service was not deployed. No later revision-stamped MCP evidence
  is tracked yet.
- `docs/design/REDESIGN-2026-08-28.md`, WP-50, WP-51, and the final freshness fix are later Git
  evidence. The repository does not record which revision production currently serves, so they
  remain deployment-unverified.

## Reconciled data behavior at `602a780`

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
  and attribution observations remain WP-55–57 work; no `packages/sp-api` exists yet.

## Open repository follow-ups

- OAuth still carries the `INTEGRATE(WP-02)` client seam.
- `EntityTagFilter` remains DB-local instead of shared; `exportBatch` remains a route-local role
  constant instead of a central auth capability.
- Dashboard fact reads do not display source provenance; imported and authoritative history must
  remain distinguishable in operator-facing coverage.
- Mirror chunks and later change-log writes are not one retry-convergent transaction; the negatives
  mirror also retains its cross-scope key-collision risk.
- Unknown match-type spellings remain target rows with a null match type.
- Report ingest does not create missing historical partitions before a backfill write.
- Dedicated SB/SD and creative analytics remain open product surfaces.

## Unverified release gates

- [ ] Latest GitHub CI result for `602a780`. The CI definition includes Postgres and Playwright,
      but WP-52 did not query GitHub.
- [ ] Repository check fully green. The WP-52 run failed the 50,000-row filter frame budget once;
      three isolated repeats passed, so the load-sensitive failure remains open.
- [ ] Database/RLS suites on the WP-52 machine; no local test Postgres was available.
- [ ] Exact deployed revisions for web, worker, and MCP.
- [ ] Hosted migration ledger reconciled to the 30 tracked SQL migrations.
- [ ] Live coverage matrix and source precedence verified without client data entering Git.
- [ ] Full current Wizard Ads route/state click-through after the latest commits.
- [ ] Fresh AdLabs and SYNQ workflow comparison. AdLabs has a durable redacted baseline in
      `tools/recon`; SYNQ has no tracked workflow evidence.
- [ ] MCP health, discovery, permitted read, audit/last-used update, denied-profile behavior, and
      Codex/Claude client checks.
- [ ] v1 crosscheck exit gate: consecutive verified days, campaign-grain parity, and explained
      optimizer spot-check.
