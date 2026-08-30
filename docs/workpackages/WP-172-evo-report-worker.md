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

An attended operator reviews the staged revision, the two encrypted credential files, and
the queue handoff before activating that same artifact:

```bash
bash docs/deploy/install-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --activate
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

Rollback names both the expected current release and one retained destination:

```bash
bash docs/deploy/rollback-report-worker-evo-systemd.sh \
  "$APPROVED_REVISION" "$PRIOR_REVISION"
```

## Shape

`install-report-worker-evo-systemd.sh` is the single public staging interface. It accepts one
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

Activation and rollback atomically switch `current` and the retained unit definition as one
recoverable operation. A failed start or health check restores the prior release link and unit;
if restoration cannot be proven, the service remains stopped for attended recovery. Health
requires the full revision, `evo-report-lane`, and exactly `creative.sync`, `report.request`,
`report.poll`, and `report.fetch`.

This is a deep deployment surface: the caller supplies only a revision and an explicit
activate/rollback decision, while checkout provenance, dependency closure, credential custody,
artifact reconciliation, systemd hardening, queue ownership, and recovery stay behind it.

## Synthesis decision

The selected base is a normalized `pnpm deploy` release because it preserves the workspace
package boundary and makes the ten inputs countable. The immutable retained-unit pattern from
the MCP service is reused, while the report worker adds a strict public-config manifest, full
artifact hashes, complete-link checks, and a worker-specific credential launcher.

Two structurally different alternatives were screened:

- A retained source checkout plus `pnpm install` exposes Git, package-manager state, and install
  timing to the service host. It cannot prove that the running dependency tree matches the
  reviewed revision, so it was rejected.
- One bundled JavaScript executable hides the workspace closure and makes native/external package
  resolution an opaque bundle concern. It weakens the required input/output package count, so it
  was rejected.

Neither surviving design exposes temporal build stages as operator API or shares mutable release
state between staging and activation.

## Tradeoffs accepted

- We accept a larger immutable artifact in exchange for preserving the complete, inspectable
  worker workspace closure.
- We accept two attended encrypted credentials in exchange for keeping long-lived values out of
  environment files, command arguments, repository content, and release files.
- We accept a separate Vercel handoff decision in exchange for making a source deploy unable to
  transfer report claims accidentally.
- We accept host-firewall verification as an activation prerequisite because the current worker
  health server binds on all interfaces and this package does not own worker source.

## Open questions and risks

- Has the attended operator verified that Vercel will retain report claims until Evo health is
  proven, then enable `OPENSPELL_EVO_REPORT_LANE_READY=1` as a separate release step?
- Does the Evo host firewall restrict the health port to the host/monitoring network?
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
- [ ] Live health proves the full revision, exclusive role, and exact four-claim set.
- [ ] Activation and rollback retain and atomically restore release, unit, and public config.
- [ ] Tests exercise provenance, artifact, config, credential, role, claim, and health refusal
  paths without Amazon, migrations, production data, or service changes.

## Activation gate

This package is deployment code only. It does not deploy, start, stop, enable, or restart a
production service. Attended activation requires the exact staged revision, both encrypted
credential files, host firewall review, exact worker health, and a separate reviewed Vercel claim
handoff. No Amazon write is part of activation.
