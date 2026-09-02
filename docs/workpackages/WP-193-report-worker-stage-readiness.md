# WP-193 — Report-worker stage readiness

## Outcome

Make the immutable Evo report-worker release safe to stage from a clean checkout and make its
attended ownership transfer unambiguous. This package changes source, CI, and documentation only.
It does not stage a release, inspect credentials, change a service, transfer queue ownership,
deploy Vercel, run a migration, touch production data, or call Amazon.

## Problem

The stage installer ran its deployment harness before installing the lockfile dependencies that
the harness executes. A clean checkout could therefore fail or, worse, validate dependencies left
by another checkout state. Hosted CI installed dependencies but never executed the deployment
harness.

The activation guide also compressed a continuous-consumer handoff into a "bounded queue cycle"
and instructed a full failback to restore Vercel ownership before stopping Evo. The former hid the
scope of work activation authorizes; the latter contradicted WP-158 and could create overlapping
report consumers. A retained rollback artifact also does not establish compatibility with the
current hosted database schema.

## Shape

- The stage installer acquires the deployment lock, creates its cleanup-owned temporary root,
  installs the exact frozen dependency graph, and only then runs the deployment harness.
- The harness statically proves that order, in addition to its existing package, provenance,
  credential, unit, readiness, recovery, and no-service-mutation checks.
- Hosted CI runs the complete deployment harness immediately after its frozen install.
- Activation records the immutable reduced Vercel deployment identity and alias cutover, then keeps
  Evo stopped until every pre-cutover invocation and running report claim has drained. A flag-only
  redeploy may reuse the same Git revision, so the SHA cannot identify the old population.
- Every old claim must be terminal or safely resumable with a known provider outcome. A possibly
  dispatched report request without a durable report ID is quarantined while both consumers remain
  stopped; asynchronous provider work may remain only with a fully accounted ID and follow-up job.
- The operator must authorize either an exact producer-quiesced backlog or the observed backlog plus
  continuing arrivals. Already-queued `creative.sync` work remains eligible even if its producer is
  disabled.
- Full lane failback quiesces producers, resolves every claim to a terminal or safely resumable
  known outcome, stops Evo, proves no in-flight claim or provider HTTP call, and only then restores
  Vercel report ownership. An unresolved or merely quarantined unknown create outcome keeps Vercel
  reduced and Evo stopped.
- Release rollback separately proves the exact destination revision is compatible with the current
  hosted migration and queue contracts.

## Acceptance

- [ ] A clean checkout installs frozen dependencies before executing the deployment harness.
- [ ] The deployment harness fails if installer lock, temporary-root, install, harness,
  post-harness cleanliness, or packaging order regresses.
- [ ] The installer refuses packaging if install or harness execution changes the clean checkout,
  and the harness proves cleanliness is rechecked before packaging.
- [ ] Hosted pull-request and main CI execute the deployment harness from a frozen install.
- [ ] The runbook never permits Vercel and Evo report claims to overlap during activation or full
  failback.
- [ ] The runbook states the continuous-consumer authority and Creative-backlog implications.
- [ ] Release rollback requires a separate exact-revision schema compatibility decision.
- [ ] Focused harness, shell syntax, repository checks, and exact-head hosted CI pass.

## External gates

Merging this package authorizes no external action. Staging one immutable release under `/opt`
requires separate authorization for the exact host and revision. Activation requires another exact
authorization after credential readiness, legacy-worker retirement, immutable Vercel deployment
cutover and drain proof, known provider outcomes, backlog scope, and rollback compatibility have
been reviewed. Production verification and any later Creative producer enablement remain separate
attended gates.
