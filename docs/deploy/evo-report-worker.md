# OpenSpell report worker on Evo X1

The Evo report worker owns exactly four queue types after an attended handoff:

- `creative.sync`
- `report.request`
- `report.poll`
- `report.fetch`

The service is an exclusive queue consumer. It does not run schedules, recommendation passes,
Marketing Stream, or other background producers. Deploying source or staging a release does not
transfer claims from Vercel.

## Runtime and credential contract

The host needs Node 22 or newer, the repository-declared pnpm, Git, systemd, `rsync`, and outbound
access to Postgres and Amazon. `/usr/local/bin/node` is the pinned service runtime.

An attended secret workflow stages two TPM-encrypted systemd credentials under these generic IDs:

- `openspell-report-worker-database-url`: one Postgres connection URL;
- `openspell-report-worker-ads-application`: JSON with exactly `clientId` and `clientSecret`.

Both files live under `/etc/credstore.encrypted`, are owned by root, and are mode `0400` or `0600`.
The repository contains no credential value, private item locator, service-account token, profile
ID, or command that retrieves a secret. Tenant Ads refresh credentials continue to live in
database Vault; the application credential is not a tenant selector.

The release public configuration contains exactly:

```dotenv
OPENSPELL_WORKER_REVISION=<full Git object ID>
WORKER_DEPLOYMENT_ROLE=evo-report-lane
WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch
```

Any additional key, abbreviated revision, other role, missing claim, or extra claim fails before
the worker imports.

## Stage an immutable release

Use a clean checkout at the exact current `origin/main` revision. Staging requires the encrypted
credential metadata to exist, but never decrypts or prints either value.

```bash
git fetch origin --prune
APPROVED_REVISION="$(git rev-parse origin/main)"
git checkout --detach "$APPROVED_REVISION"
test "$APPROVED_REVISION" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=normal)"
bash docs/deploy/test-report-worker-evo-systemd.sh
bash docs/deploy/install-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION"
```

The installer creates `/opt/openspell-report-worker/releases/<revision>` as a root-owned,
read-only artifact. It packages the worker with all injected workspace dependencies, normalizes
checkout-derived metadata, counts all ten workspace inputs and outputs, verifies every symlink,
hashes every regular file, and reconciles the staged and installed trees.

Staging does **not** write `/etc/systemd/system`, switch `current`, call `systemctl`, or change any
service state. Review the retained revision, `public.conf`, `WORKSPACE_MANIFEST.json`,
`ARTIFACT_COUNTS`, `ARTIFACT_LINKS`, `ARTIFACT_SHA256`, and unit before activation.

## Attended activation and queue handoff

Confirm the health port is restricted by the host firewall to the host or approved monitoring
network. The current worker server listens on port 3000 and this deployment package does not alter
that application behavior.

Activate the already staged release:

```bash
bash docs/deploy/install-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --activate
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

Activation verifies the retained artifact and unit, atomically switches `current`, installs the
release-owned unit, reloads systemd, restarts only `openspell-report-worker.service`, and requires
exact local health. Failure restores the prior release link and prior unit; when restoration cannot
be proven, the service remains stopped for attended recovery.

Only after Evo health passes should the separately reviewed web/Vercel deployment set
`OPENSPELL_EVO_REPORT_LANE_READY=1`. That handoff removes the three report claims from Vercel;
`creative.sync` has no Vercel owner. Re-run both health and queue-ledger checks after the handoff.
Revert the Vercel flag before stopping Evo during a planned failback.

## Live verification

```bash
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

The verifier requires an active service and checks the complete retained artifact. `/healthz` must
report `status: "ok"`, the full revision, role `evo-report-lane`, and exactly the four ordered claim
types above. It also requires background Marketing Stream to remain disabled in this role.

Health proves process identity and claim configuration, not report correctness. Complete the live
read-only release gate with one bounded queue cycle and reconcile requested, claimed, provider,
parsed, refused, promoted, and canonical counts in the existing report ledger. Confirm no Amazon
mutation job was claimed or API write invoked.

## Rollback

Resolve one retained prior revision and verify that Vercel owns report claims before stopping the
current Evo lane. Then run:

```bash
bash docs/deploy/rollback-report-worker-evo-systemd.sh \
  "$APPROVED_REVISION" "$PRIOR_REVISION"
```

Rollback refuses stale `current`, incomplete artifacts, mismatched units, or invalid destination
health. It switches the release link and release-owned unit together. On failure it restores the
original release, unit, and public configuration through the original `current` target; otherwise
it stops the service and requests attended recovery.

This service has no migration step. Staging, activation, verification, and rollback do not modify
application data or invoke Amazon.
