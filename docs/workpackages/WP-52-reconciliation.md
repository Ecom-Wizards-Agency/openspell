# WP-52 — Repository, evidence, and deployment reconciliation

**Status:** review · **Owner:** Codex · **Branch:** `wp-52-reconciliation`

## Goal

Establish a public-safe starting point for WP-53 onward. This package reconciles the current
Git revision, work-package history, routes, migrations, CI definition, historical-sync behavior,
design/QA records, and competitor evidence without treating code, tests, and deployed behavior
as interchangeable evidence.

## Scope and boundaries

- Documentation only. No application, package, migration, seed, or deployment files change.
- No production database, Amazon, deployment, competitor, Cap, or browser access.
- No production migration or roadmap write.
- Client names, profile identifiers and counts, credentials, private doctrine values, absolute
  home paths, and private reference-repository material stay out of the record.
- `origin/main` at `602a780` is the repository baseline. A Git merge proves that code is on
  `main`; it does not prove CI, deployment, migration application, live data correctness, or a
  working operator flow.

## Evidence classes

| Class | What it can prove | What it cannot prove |
|---|---|---|
| Repository | Tracked source, tests, migrations, routes, Git reachability | A current CI run, deployment, hosted schema, or live data |
| Local verification | A command run in this checkout and its observed result | Production behavior or a different runtime |
| Dated live record | What a named QA record says was observed on its date | That later commits are deployed or still behave the same |
| Unverified | A required gate with no durable evidence in this package | Nothing may be inferred from it |

## Reconciled baseline

### Git and work packages

- `HEAD`, `origin/main`, and the WP-52 branch base were all `602a780` at inventory time.
- Git history contains merge commits for WP-33, 34, 35, 36, 38–44, 44B, 47A, 47B, and 48–51.
  WP-21 and WP-22 are also merged but were missing from the prior status table.
- There is no tracked WP-20, WP-37, WP-45, or WP-46 implementation brief. Number gaps are not
  evidence that a package existed or shipped.
- WP-47A is represented by its architecture/QA records and merge commit, not a numbered
  implementation brief in `docs/workpackages/`.

### Current repository surface

At `602a780`, the tracked tree contains:

- 17 workspace packages with source and tests;
- 28 App Router page files and 24 route-handler files under `apps/web/app`;
- 30 SQL migrations under `supabase/migrations`;
- 157 test/spec files outside `apps/web/e2e` and 10 Playwright spec files.

These are inventory counts, not proof that every surface is deployed or exercised.

The CI workflow now defines a Postgres-backed check job and a separate serial Playwright job.
This package did not query GitHub, so the result of the latest CI run is unverified.

### Local verification on the baseline

`pnpm check` reached typecheck and lint successfully, then failed in the unit-test stage when
`packages/ui/src/pipeline.perf.test.ts` measured the 50,000-row filter path at about 41 ms against
its 16 ms budget. The same performance file passed on three isolated reruns. The honest result is
therefore **not green**: the full-suite run exposed a load-sensitive performance-budget failure.
The database-backed suites skipped because no local test Postgres was available, and Playwright
was not run by `pnpm check`.

The repeat command was
`pnpm --filter @wizard-ads/ui exec vitest run src/pipeline.perf.test.ts --reporter=dot`, invoked
independently three times after the full-suite failure. Each run reported one passing file and
seven passing tests; total durations were 1.10 s, 0.97 s, and 1.00 s. These passes prove only that
the failure is load-sensitive, not that the release gate is green.

Authenticated Chrome/CDP, competitor, and deployed-route QA were deliberately not attempted:
the assigned WP-52 scope forbids external systems. Those checks remain explicit WP-65 gates.

## Historical sync and data provenance

The following behavior is proven by the current source and tests.

1. `apps/worker/src/schedules.ts` provisions, per report type, a daily 3-day recent request, a
   weekly 32-day restatement request, and a weekly 32-day comparison request offset by 32 days.
   The recent request overlaps the restatement block, so the distinct scheduled coverage is about
   64 contiguous days, not 67 days and not account lifetime.
2. Entity tables are current-state mirrors. A full listing tombstones entities omitted by the
   provider, and `entity_changes` records differences observed after the first mirror snapshot.
   The repository has no source for entity states from before connection.
3. Daily fact loaders use `ON CONFLICT DO UPDATE` at their canonical grain. A later report replaces
   metrics for keys it includes. The report ledger retains request status and row counts, but the
   previous metric values and parsed source rows are not retained.
4. Promotion is not report-date transactional. There is no promotion watermark or request-order
   guard, so an older report that finishes late can overwrite newer canonical evidence.
5. Upsert-only loading does not remove a canonical entity-grain fact omitted from a later complete
   report. The stale-row reconciliation described for WP-57 is absent.
6. Daily retention is 26 months for most facts and 13 months for search terms. Expired partitions
   are rolled into `fact_monthly_rollup` before detailed partitions are dropped.
7. The web application applies one generic 14-day settling rule and can clamp the displayed current
   KPI window to the first available fact day. It does not derive an account-specific maturity
   curve. The comparison window is not yet rebalanced after a current-window coverage clamp, so
   incomplete like-for-like comparison suppression remains a data-trust gate.
8. The Amazon Ads report-ingestion path contains Reporting v3 only. It has no unified-report
   capability probe, maximum-history bootstrap, promotion watermark, attribution-observation
   table, or superseded-fact ledger. No `packages/sp-api` package exists at this revision.

Existing incumbent-derived history is explicitly source-labelled, and the crosscheck excludes it.
That is repository behavior; hosted coverage and source counts were not queried here.

## Design, QA, Cap, and competitor evidence

- `docs/design/AUDIT-2026-08-27.md` and `docs/design/QA-2026-08-27.md` are dated live-production
  records. The second QA round says the brand system, settled-window presentation, several flow
  repairs, target-level bid columns, and Bugs/Roadmap split were observed live on that date.
- `docs/design/REDESIGN-2026-08-28.md` documents later cockpit, optimizer, grid, and coverage work,
  but its infrastructure notes refer to a development preview. It is repository/design evidence,
  not proof of a production deploy.
- The repository does not store the deployed Git revision. WP-50, WP-51, the final freshness fix,
  and any redesign commits after the dated live QA therefore remain deployment-unverified.
- The last dated live QA record says the MCP host was not deployed and the web endpoint setting was
  unset. WP-54 must supersede that evidence with a revision-stamped deployment and client checks.
- `tools/recon/` contains the established AdLabs evidence: tagged source confidence, redacted
  screenshots, a read-only walkthrough record, and explicit gaps. It remains the durable competitor
  baseline; this package made no competitor calls.
- The operator recording is represented only by the derived WP-24 brief in this public repository.
  No media or transcript is tracked, so WP-52 makes no new claim from it.
- The only tracked SYNQ material is a planning-level feature note in `docs/PLAN.md`. There is no
  SYNQ route or workflow walkthrough to reconcile. The requested comparison remains unverified.

## Deployment and hosted-state drift

The repository can prove that code and migrations exist. It cannot currently prove:

- which Git revision the web, worker, or MCP runtime is serving;
- whether the 30 local SQL migrations match the hosted migration ledger;
- whether the latest CI workflow passed on `602a780`;
- whether current hosted fact coverage is contiguous by profile, report type, date, grain, and
  source;
- whether later report completion has produced stale or out-of-order canonical facts;
- whether the current roadmap rows match the seed manifest;
- whether the latest application routes work in loaded, empty, partial, stale, error, and denied
  states.

No production/shared migration or seed preview was generated because the target and proposed
migration set belong to WP-56 and require separate authorization before application.

## Reconciled repository follow-ups

The prior status board mixed resolved and still-open follow-ups. At `602a780`:

- **Resolved in repository:** CI defines Postgres and Playwright jobs; database-heavy CI tests are
  serialized; web development/build explicitly stays on webpack; profile persistence and the
  direct-visit cookie fallback exist; `jsdom` is declared by the web package.
- **Still open:** the OAuth callback retains its `INTEGRATE(WP-02)` client seam; `EntityTagFilter`
  remains DB-local instead of shared, while `exportBatch` remains a route-local role constant
  instead of a central auth capability; dashboard fact reads do not surface source provenance;
  mirror chunks and their later `entity_changes` writes are not
  one retry-convergent transaction; the negatives mirror still collapses scopes onto one key; an
  unknown match-type spelling is retained as a target with null match type; report ingest does not
  ensure missing historical partitions; dedicated SB/SD and creative analytics remain absent.
- **New from WP-52:** the full-suite grid performance budget failed once and passed three isolated
  repeats. It remains a release-gate flake until reproduced under a controlled benchmark runner or
  the budget implementation is made load-tolerant without weakening the product target.

## Acceptance record

- [x] Reconciled the WP-52 branch base to `origin/main` at `602a780`.
- [x] Reconciled merged WP history through WP-51 without inventing missing packages.
- [x] Counted routes, migrations, workspaces, and test files from the tracked tree.
- [x] Distinguished repository, local, dated-live, and unverified evidence.
- [x] Documented the current 64-day scheduled coverage and canonical-overwrite behavior.
- [x] Documented missing report promotion, stale-row reconciliation, revision observation, and
  unified-history foundations.
- [x] Reconciled the prior manager follow-up list into resolved and still-open repository items.
- [x] Reconciled Fable/design, AdLabs, Cap-derived, and SYNQ evidence without external access.
- [x] Ran the repository check and repeat performance test; recorded the non-green result.
- [x] Updated `docs/STATUS.md` with current merged work and release gates.
- [ ] Latest GitHub CI run verified.
- [ ] Exact deployed revisions verified for web, worker, and MCP.
- [ ] Hosted migrations and live coverage matrix verified.
- [ ] Full current Wizard Ads, AdLabs, and SYNQ browser QA completed.
