# WP-172 — Immutable Evo report worker

## Problem

The exclusive `evo-report-lane` exists in worker source, but the only always-on worker
runbook still installs a mutable checkout and keeps its database URL in a plaintext
environment file. The report lane also has a larger runtime closure than MCP: ten injected
workspace packages, including `@wizard-ads/sp-api`, plus the TypeScript executor. A release
must prove that complete closure came from one clean `origin/main` revision without copying
checkout paths, secrets, profile selectors, tests, or deployment state into the artifact.

## Usage (operator view)

An unattended build may stage one exact release. It cannot change systemd or a running
process:

```bash
git fetch origin --prune
APPROVED_REVISION="$(git rev-parse origin/main)"
git checkout --detach "$APPROVED_REVISION"
bash docs/deploy/install-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION"
```

An attended operator reviews the staged revision and encrypted credential metadata while
Vercel still owns reports. Vercel then relinquishes its report claims and the operator records
that attended check explicitly before activating the already-staged artifact:

```bash
bash docs/deploy/activate-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --vercel-report-claims-relinquished
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

Rollback names both the expected current release and one retained destination:

```bash
bash docs/deploy/rollback-report-worker-evo-systemd.sh \
  "$APPROVED_REVISION" "$PRIOR_REVISION"
```

## Shape

`install-report-worker-evo-systemd.sh` is the stage-only interface. It accepts one
full Git object ID, requires that ID to equal a clean `origin/main` checkout, packages only
`@wizard-ads/worker`, injects the pinned TypeScript runtime, and delegates workspace-path
normalization to `normalize-report-worker-evo-artifact.mjs`. The normalizer expects exactly
ten workspace packages, records offered and normalized counts, and rejects a missing or extra
package. Runtime source is pruned of tests and fixtures before publication.

Every release retains its exact unit, strict three-key public configuration, workspace/count
manifest, symlink inventory, regular-file hashes, and full revision under
`/opt/openspell-report-worker/releases/<revision>`. Staging copies to a root-owned incoming
directory, reconciles file, directory, and link counts plus byte content, then publishes with
one rename. It does not install a unit, switch `current`, or call `systemctl`.

The systemd unit loads exactly two TPM-encrypted credentials: a database URL and a generic Ads
application JSON object. `openspell-report-worker-launch.mjs` validates those private files,
the retained revision, and the three-key public configuration before setting the process-only
`DATABASE_URL`, `LWA_CLIENT_ID`, and `LWA_CLIENT_SECRET`. It contains no 1Password locator,
profile selector, or service token. Tenant refresh credentials remain in database Vault.

Every stage, activation, verification, and release rollback takes the same root-owned `flock`.
Activation refuses unless the legacy unit is absent or exactly inactive and disabled. Activation
and rollback switch `current` and the retained unit definition as one recoverable
operation. A failed start or health check restores only a prior release whose full artifact,
current-link suffix, retained unit, live unit, service state, and exact health were proven. If
restoration cannot be reproven, the service remains stopped for attended recovery. Health requires
the full revision, `evo-report-lane`, and exactly `creative.sync`, `report.request`, `report.poll`,
and `report.fetch`. The immutable launcher binds that health server to loopback.

Before the worker module can import or open health, the credential launcher performs one bounded,
read-only database transaction. It proves service-role access, the queue relation and enum, the
filtered claim function's execute grant, and a zero-row queue read. Its hard deadline includes a
server that accepts TCP but never completes the Postgres protocol. Every failure collapses to one
sanitized message; no URL, host, credential, row, or count reaches output.

This is a deep deployment surface: the caller supplies only a revision and an explicit
activate/rollback decision, while checkout provenance, dependency closure, credential custody,
artifact reconciliation, systemd hardening, queue ownership, and recovery stay behind it.

## Synthesis decision

The selected base remains the normalized `pnpm deploy` release because it preserves the workspace
package boundary and makes the ten inputs countable. For the recovery amendment, the testability
candidate supplied a separate stage/activate interface and injectable readiness boundary; the
recovery candidate supplied the complete prior-state proof and single-operation lock; the
small-surface candidate supplied the warning that current web health cannot machine-prove Vercel's
effective claims. The synthesis therefore requires an explicit attended handoff assertion without
mislabeling it as automated evidence, and blocks legacy overlap mechanically. A signed Vercel
claim receipt was rejected because no producer exists in the owned scope.

Two structurally different alternatives were screened:

- A retained source checkout plus `pnpm install` exposes Git, package-manager state, and install
  timing to the service host. It cannot prove that the running dependency tree matches the
  reviewed revision, so it was rejected.
- One bundled JavaScript executable hides the workspace closure and makes native/external package
  resolution an opaque bundle concern. It weakens the required input/output package count, so it
  was rejected.

Staging and activation are separate operator decisions because WP-158 places the Vercel handoff
between them. Neither interface exposes packaging internals or shares mutable checkout state.

## Tradeoffs accepted

- We accept a larger immutable artifact in exchange for preserving the complete, inspectable
  worker workspace closure.
- We accept two attended encrypted credentials in exchange for keeping long-lived values out of
  environment files, command arguments, repository content, and release files.
- We accept a separate Vercel handoff decision in exchange for making a source deploy unable to
  transfer report claims accidentally.
- We accept immediate refusal instead of waiting for a deployment lock in exchange for keeping
  every state transition explicit and bounded.
- We accept attended Vercel claim evidence in this package because the current public web health
  contract exposes revision, not effective queue ownership; the activation flag is an assertion,
  not a machine probe.

## Open questions and risks

- Has the attended operator verified the compatible Vercel revision, set the report-lane handoff,
  redeployed, and observed reduced Vercel ownership before invoking activation?
- Should a future web package expose a signed, short-lived effective-claim receipt so activation
  can replace its attended assertion with machine evidence?
- Are both encrypted credentials sealed on this Evo host under the exact runtime IDs in the
  deployment guide?

## Acceptance

- [ ] A clean, exact `origin/main` revision stages a root-owned immutable release without changing
  systemd or a running service.
- [ ] The artifact reconciles all ten workspace inputs and explicitly includes `sp-api`.
- [ ] Dirty, abbreviated, mismatched, incomplete, path-bound, writable, or extra-config artifacts
  fail closed.
- [ ] Missing/unsafe encrypted credentials and invalid Ads application JSON fail closed without
  printing a value.
- [ ] An accepted-but-silent database socket, missing queue contract, or insufficient access stops
  before worker import and emits no connection or data detail.
- [ ] Activation refuses until Vercel relinquishment is explicitly acknowledged and the legacy
  worker is absent or exactly inactive and disabled.
- [ ] Live health proves the full revision, exclusive role, and exact four-claim set.
- [ ] Activation and rollback retain and atomically restore release, unit, and public config.
- [ ] Concurrent stage, activation, or rollback operations allow one mutator and refuse the rest.
- [ ] Tests exercise provenance, artifact, config, credential, role, claim, and health refusal
  paths without Amazon, migrations, production data, or service changes.

## Activation gate

This package is deployment code only. It does not deploy, start, stop, enable, or restart a
production service. Attended activation requires the exact staged revision, both encrypted
credential files, verified Vercel relinquishment before Evo starts, a
retired legacy worker, and exact worker health. Current web health cannot prove effective Vercel
claims, so `--vercel-report-claims-relinquished` records attended evidence rather than automated
evidence. No Amazon write is part of activation.
