# WP-158 — Exclusive Creative/report lane

## Outcome

Define, but do not activate, a disjoint deployment boundary for Sponsored
Brands Video creative and Reporting v3 work. The existing Vercel cron remains
the owner of entity, report, and recommendation jobs after this source change.
An explicitly configured Evo runtime can later own only `creative.sync` and the
three report lifecycle jobs.

This package changes source and tests only. It does not deploy a runtime,
change an environment value, run a migration, access credentials, or call
Amazon.

## Ownership contract

- With `OPENSPELL_EVO_REPORT_LANE_READY` absent or `0`, Vercel retains the
  current five-type claim set: entity sync, report request/poll/fetch, and
  recommendations.
- With the exact Vercel value `1`, Vercel retains only entity sync and
  recommendations. Any other configured value returns a sanitized 503 before
  database or Amazon wiring.
- `WORKER_DEPLOYMENT_ROLE=evo-report-lane` requires `WORKER_JOB_TYPES` to be
  exactly `creative.sync,report.request,report.poll,report.fetch` as a set.
  Missing, partial, unknown, or additional types fail startup.
- The Evo report role starts the claim loop and health endpoint only. It does
  not start auth probes, schedule provisioning, stale-claim reaping, bid-series
  synchronization, recommendation observation, or Marketing Stream polling.
- Health may expose only the role and effective job-type ownership. It does not
  expose environment values, hosts, account data, or credentials.

## Activation order

Source merge does not activate the split. Activation is a separately attended
deployment operation:

1. Deploy the compatible source to Vercel with the handoff flag absent and
   verify that its health and cron drain still use the default ownership set.
2. Install and validate the Evo service configuration while the service is
   stopped. Its role and exact four-type allowlist must pass the production
   startup check; its health must report that sanitized ownership.
3. Set `OPENSPELL_EVO_REPORT_LANE_READY=1` on Vercel, redeploy, and verify that
   Vercel claims only entity sync and recommendations. Report jobs may remain
   queued during this bounded gap; no second report consumer is started.
4. Start the Evo report runtime and verify its health, one synthetic/dry queue
   claim, and the absence of overlap between the two reported claim sets.
5. Observe queue age, failures, and report-ledger counts before scheduling or
   enabling any creative producer.

Rollback reverses the order: stop Evo first, restore the Vercel flag to `0` or
remove it, redeploy, and verify the original five-type claim set before changing
anything else.

## Acceptance evidence

- Pure tests pin the current default Vercel set.
- Pure tests prove the activated Vercel and Evo sets have an empty intersection.
- Worker configuration tests refuse absent, partial, and foreign report-lane
  allowlists and canonicalize the exact set.
- Route tests prove malformed Vercel handoff values stop before database or
  Amazon client construction.
- Health tests prove the queue role and types are sanitized and explicit.
- Typecheck, lint, tests, and public-repository hygiene pass with synthetic data.
