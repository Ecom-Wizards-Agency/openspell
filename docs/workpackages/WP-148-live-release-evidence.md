# WP-148 — Live release evidence

## Outcome

Reconcile the repository, hosted CI, deployed web and MCP revisions, authenticated operator
workflows, measured performance, and remaining GitHub work after the 2026-08-30 release wave.
This package changes evidence only. It does not change application behavior, schemas, credentials,
provider configuration, or Amazon state.

## Verified release

- At release capture, `origin/main` and the production web application resolved to the same full
  Git revision. This evidence-only package may advance main without requiring a runtime rollout.
- The exact-main GitHub run passed typecheck, lint, tests, hygiene, migrations, build, and the
  Playwright job before promotion.
- Authenticated production checks cover Dashboard, Grid, Campaign Optimizer, Creative Performance,
  Query Intelligence, Dayparting, Time Machine, Connect AI, and the experiment scope selector.
- Grid nested grouping and filtered selection work on the live account. No experiment was created,
  no export was downloaded, and no Amazon write was invoked.
- The MCP service remains healthy but has explicit revision drift from the web release.

## Open acceptance gaps

- Live Grid and Time Machine first-use latency remain above their performance targets.
- Marketing Stream correction, settling, subscription-binding, and locking behavior is under
  recovery review and is not live-complete.
- The guarded Sponsored Products write gateway, weekday preview schedule, campaign-creation
  contracts, contextual-negative review/export, and current Advertising API capability map remain
  open pull requests.
- The deployed MCP service still requires a current-revision rollout and another authenticated
  Codex/Claude verification after deployment.

## Safety assertions

- No production or shared migration was run in this package.
- No credential, profile identifier, client label, private threshold, or real account data enters
  the repository.
- No Amazon mutation was invoked during release or browser verification.
