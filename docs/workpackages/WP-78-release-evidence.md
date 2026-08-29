# WP-78 — Release evidence and status reconciliation

## Outcome

Integrate the final ungated operator-foundation packages, reconcile the public
program documents with verified code and deployment evidence, and deploy one
revision-stamped candidate. This package does not add a product capability or
authorize a production migration, seed, Amazon write, AWS resource change or
competitor-product mutation.

## Included evidence

- WP-75 makes weekly SQP report polling durable across retries and process
  restarts while keeping missing profile authentication and scheduling inputs
  visible as live gates.
- WP-76 shortens the grid cold critical path and verifies the known 3,597-row
  server query and mapping fixture in under two seconds.
- WP-77 reconciles exported SP bid recommendations against exact synchronized
  bid history and settled matched evidence, beginning on the next full
  profile-local day.
- `docs/STATUS.md` uses the actual WP-70 through WP-77 package names and separates
  merged code, deployed revisions and live provider verification.
- `docs/PLAN.md` identifies its original phase table as historical and records
  which read-only intelligence lanes were pulled forward without weakening the
  global write gate.

## Release gate

1. Every included pull request must pass the hosted typecheck, lint, test,
   hygiene, migration and Playwright jobs before merge.
2. The combined main tree must pass `pnpm check` and a production web build.
3. The web and always-on MCP deployments must report ready at the exact approved
   revision before handoff.
4. Authenticated product QA is reported only when the shared operator browser is
   actually signed in. A login page is a gate, not a successful click-through.

No plaintext credential, client data, doctrine default, private reference
material or absolute operator path belongs in this evidence package.
