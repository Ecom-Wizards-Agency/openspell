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

The host needs Node 22 or newer, the repository-declared pnpm, Git, systemd, `flock`, `rsync`, and outbound
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

Use a clean checkout at the exact current `origin/main` revision. Staging neither requires nor
reads live credential metadata.

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

Staging does **not** write `/etc/systemd/system`, switch `current`, inspect credentials, call
`systemctl`, or change any
service state. Review the retained revision, `public.conf`, `WORKSPACE_MANIFEST.json`,
`ARTIFACT_COUNTS`, `ARTIFACT_LINKS`, `ARTIFACT_SHA256`, and unit before activation.

## Attended activation and queue handoff

First verify `wizard-ads-worker.service` is either absent or exactly inactive and disabled. The
activation script checks this state and never stops or disables the legacy unit. The immutable
launcher binds OpenSpell health to `127.0.0.1:3000`.

Follow WP-158's no-overlap order: set `OPENSPELL_EVO_REPORT_LANE_READY=1` on Vercel, redeploy, and
verify that Vercel retains only entity sync and recommendations. Report jobs may remain queued in
this bounded gap. Only then activate the already staged release and record that attended check:

```bash
sudo bash docs/deploy/activate-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --vercel-report-claims-relinquished
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

Activation verifies the retained artifact and unit, atomically switches `current`, installs the
release-owned unit, reloads systemd, restarts only `openspell-report-worker.service`, and requires
exact local health. Before importing the worker or its health module, the launcher runs one bounded
read-only transaction that proves service-role access and the queue table, enum, claim function,
and permissions without claiming a job. A silent accepted TCP connection fails within the hard
deadline and emits only a sanitized error. Failure is called restored only after the prior artifact,
retained and live unit, enabled/active state, and exact health all pass; otherwise the service
remains stopped for attended recovery.

The flag is an attended assertion, not an independent remote probe: current public web health
exposes revision but not effective claims. Never provide it before completing the Vercel check.
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

Resolve one retained prior revision while Vercel remains on its reduced claim set. A release
rollback keeps report ownership on Evo; it is not the WP-158 lane failback. Then run:

```bash
bash docs/deploy/rollback-report-worker-evo-systemd.sh \
  "$APPROVED_REVISION" "$PRIOR_REVISION"
```

Rollback refuses stale `current`, incomplete artifacts, a mismatched live unit, an unretired legacy
service, or an invalid destination. It first proves the complete current live deployment and the
destination release. On failure it reports restoration only after the original artifact, live unit,
enabled/active state, and exact health pass; otherwise it stops the service for attended recovery.

All four deployment operations serialize through one root-owned `flock` file. A concurrent
operation fails closed instead of observing or creating a partial transition.

This service has no migration step. Staging, activation, verification, and rollback do not modify
application data or invoke Amazon.
