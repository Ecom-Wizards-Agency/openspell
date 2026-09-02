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

Staging writes a privileged release under `/opt`, so obtain separate authorization for the exact
host and revision first. After that authorization, use a clean checkout at the exact current
`origin/main` revision. Staging neither requires nor reads live credential metadata.

```bash
git fetch origin --prune
APPROVED_REVISION="$(git rev-parse origin/main)"
git checkout --detach "$APPROVED_REVISION"
test "$APPROVED_REVISION" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=normal)"
bash docs/deploy/install-report-worker-evo-systemd.sh \
  --revision "$APPROVED_REVISION"
```

The installer creates `/opt/openspell-report-worker/releases/<revision>` as a root-owned,
read-only artifact. Under the deployment lock, it installs the frozen dependency graph and runs
the complete deployment harness before packaging the worker with all injected workspace
dependencies. It normalizes checkout-derived metadata, counts all ten workspace inputs and
outputs, verifies every symlink, hashes every regular file, and reconciles the staged and installed
trees.

Staging does **not** write `/etc/systemd/system`, switch `current`, inspect credentials, call
`systemctl`, or change any
service state. Review the retained revision, `public.conf`, `WORKSPACE_MANIFEST.json`,
`ARTIFACT_COUNTS`, `ARTIFACT_LINKS`, `ARTIFACT_SHA256`, and unit before activation.

## Attended activation and queue handoff

First verify `wizard-ads-worker.service` is either absent or exactly inactive and disabled. The
activation script checks this state and never stops or disables the legacy unit. The immutable
launcher binds OpenSpell health to `127.0.0.1:3000`.

Follow WP-158's no-overlap order while Evo remains stopped: set
`OPENSPELL_EVO_REPORT_LANE_READY=1` on Vercel and redeploy the exact compatible source. Record the
new immutable Vercel deployment identity and alias-cutover timestamp; a flag-only redeploy may have
the same Git revision as the deployment it replaces. Verify that the new deployment retains only
entity sync and recommendations. The flag is an assertion about new claimers; it does not stop an
invocation from the pre-cutover deployment. Use Vercel execution history and the queue/provider
ledgers to prove that no invocation from the old deployment, running `vercel-cron-*` report claim,
or in-flight provider HTTP call remains before starting Evo.

Every prior claim must also be terminal or safely resumable with a known provider outcome. A
`report.request` that might have reached Amazon but lacks a durably stored report ID has an unknown
create outcome: quarantine it and keep both report consumers stopped until it is resolved.
Provider-side asynchronous reports may remain only when their durable report IDs and follow-up jobs
are completely accounted. Other report jobs may remain queued in this no-consumer gap.

The Evo service is a continuous four-type consumer, not a one-cycle command. Before activation,
either quiesce every producer and record the exact eligible backlog or explicitly authorize the
complete observed backlog plus jobs that may arrive while the service runs. Include already-queued
`creative.sync` jobs in that scope even when the Creative producer gate is off. Only after those
checks may the operator activate the staged release and record the attended handoff:

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
exposes revision but not effective claims. Never provide it before completing the Vercel and
in-flight-work checks.

For a full lane failback, first disable or quiesce report and Creative producers. Let every Evo
claim become terminal or safely resumable with a known provider outcome, and quarantine any
possibly dispatched request without a durable report ID. Stop Evo and prove that no Evo claim or
provider HTTP call remains in flight. Only then remove or zero the Vercel flag, redeploy the exact
compatible Vercel source, record its immutable deployment identity and alias cutover, and prove
that its original five-type ownership is live. Provider-side asynchronous reports may remain only
when their durable IDs and follow-up jobs are accounted. If any proof is ambiguous, keep Vercel
reduced and Evo stopped; do not create a second report consumer.

## Live verification

```bash
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

The verifier requires an active service and checks the complete retained artifact. `/healthz` must
report `status: "ok"`, the full revision, role `evo-report-lane`, and exactly the four ordered claim
types above. It also requires background Marketing Stream to remain disabled in this role.

Health proves process identity and claim configuration, not report correctness. Define an attended
observation window before the service starts, then reconcile its eligible backlog and arrivals
against requested, claimed, provider, parsed, refused, promoted, and canonical counts in the
existing report ledger. Record the start and end watermarks and explain every unfinished row. This
is an observation of a continuous consumer, not a promise that activation claims only one batch.
Confirm no Amazon mutation job was claimed or API write invoked.

## Rollback

Resolve one retained prior revision while Vercel remains on its reduced claim set. Independently
prove that the exact destination revision is compatible with the current hosted migration ledger,
queue enum and claim function, report schema, and any persisted scheduling contract it imports;
artifact retention and health do not prove database compatibility. A release rollback keeps report
ownership on Evo; it is not the WP-158 lane failback. Then run:

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

This service has no migration step. Staging and passive verification do not modify application
data or invoke Amazon. Activation and release rollback start or restart the continuous consumer;
they therefore authorize queue and report-ledger writes plus the Amazon read/report operations of
the approved four job types. They do not authorize an Amazon advertising mutation. Full lane
failback changes both service and Vercel deployment state and remains a separate attended action.
