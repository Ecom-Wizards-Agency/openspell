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
WORKER_CLAIM_PROTOCOL=fenced
WORKER_CLAIM_BATCH_SIZE=1
WORKER_MAX_CONCURRENT_JOBS=1
```

Any additional key, abbreviated revision, other role, missing claim, or extra claim fails before
the worker imports. The exact `WORKER_CLAIM_PROTOCOL=fenced` marker is also required of every
automatic activation or rollback destination; a retained pre-WP-194 artifact is not compatible.
The batch and concurrency limits keep this safety release at one claim and one provider operation
at a time. They are exact contract values, not tuning defaults.

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

Activation verifies the retained artifact, exact fenced protocol marker, credential metadata, and
hosted database contract before touching service state. The transition invokes the readiness helper
from the clean reviewed deployment checkout, not a helper supplied only by the candidate release.
For activation, the checkout must still be at the full staged revision and the tracked helper must
retain executable mode. Database readiness requires the nullable UUID `claim_token` column without
a default, its valid unique partial
index, private authority-table shape and ACL, and no tenant-readable claim token. It resolves both
legacy claim overloads, legacy finish and stale reaper, all three fenced transitions, and the
authority getter and activator by exact signature. For all nine functions it requires the committed
SHA-256 of the exact `pg_proc.prosrc`, owner `postgres`, PL/pgSQL, expected volatility,
non-leakproof security-definer mode, fixed search path, returns, argument names/defaults, and the
exact owner plus `service_role` execute ACL. The probe is one bounded read-only transaction and
emits only a sanitized error.

For an upgrade, activation proves the current revision live and fenced, stops it, and proves it
inactive. For a first activation, it instead proves that both `current` and the unit are exactly
absent. It then captures a read-only SHA-256 custody snapshot over every four-lane queue row and
refuses to continue while any lane row is running or token-bearing. Only after the human Vercel
assertion and that drained proof does it call the database's atomic, idempotent, one-way authority
flip. The RPC locks the authority row and rechecks custody in the same transaction. Activation then
independently re-proves fenced authority and drained custody before it switches `current`, installs
the release-owned unit, or starts the service. A lost activation response is safe only when those
read-only proofs establish that the flip committed and custody is still drained.

There is no deployment operation that restores legacy report authority. After the flip, legacy
claim and stale-reaper paths remain database-blocked for these four types even if a human changes an
external flag. A failed start may restart the exact prior fenced revision only when a second custody
snapshot is byte-identical and drained. On first activation, it may restore exact service absence
only when no claim occurred; database authority remains fenced. Any snapshot change, unresolved
claim, database failure, failed stop or disable command, or uncertain service state leaves the
service provably inactive and disabled when that can be established, and otherwise reports that
inactivity could not be proved.

The command-line flag is a recorded human assertion, not an independent remote probe or authority
proof. The activator also proves local process state, exact database schema and grants, and queue
custody. It cannot prove that
a pre-cutover serverless invocation or provider HTTP request has ended. Never provide the flag before
completing the Vercel execution-history and in-flight-provider checks above.

After fenced authority is active, the old Vercel report lane is not a failback destination. Removing
or zeroing its external flag does not reverse database authority and must not be presented as a
recovery step. A future failback requires a separately reviewed, authority-compatible fenced
consumer and an attended handoff with the same provider and custody proofs. Until that exists,
resolve an Evo failure by restoring a retained fenced Evo revision or keep every report consumer
stopped.

## Live verification

```bash
bash docs/deploy/verify-report-worker-evo-systemd.sh "$APPROVED_REVISION"
```

The verifier requires fenced database authority and an active service, then checks the complete
retained artifact. `/healthz` must
report `status: "ok"`, the full revision, role `evo-report-lane`, claim protocol `fenced`, and exactly
the four ordered claim types above. It also requires background Marketing Stream to remain disabled
in this role.

Health proves process identity and claim configuration, not report correctness. Define an attended
observation window before the service starts, then reconcile its eligible backlog and arrivals
against requested, claimed, provider, parsed, refused, promoted, and canonical counts in the
existing report ledger. Record the start and end watermarks and explain every unfinished row. This
is an observation of a continuous consumer, not a promise that activation claims only one batch.
Confirm no Amazon mutation job was claimed or API write invoked.

At every service start, the launcher repeats the exact schema proof and then reads authority plus
unresolved custody in one read-only transaction before importing worker code. Non-fenced authority
or any running or token-bearing report claim exits with status 78; systemd does not restart that
exit. This prevents a crashed process from silently reacquiring work while prior custody is
ambiguous. Database-readiness failures use the bounded restart policy; custody and authority
failures require attended resolution.

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
service, a destination without the exact fenced marker, a database that fails exact readiness, or
authority that is not already fenced. It never changes authority.
It stops and proves the source inactive, then requires a drained custody snapshot before changing the
link. If the destination fails to start, the original revision is restarted only when the post-failure
snapshot exactly matches the drained pre-switch snapshot. Otherwise both revisions remain stopped.

All four deployment operations serialize through one root-owned `flock` file. A concurrent
operation fails closed instead of observing or creating a partial transition.

This service has no migration step. Applying WP-194's separately reviewed ordered migration set is
a distinct authorization; no deployment helper applies it. Staging and passive verification do not
modify application data or invoke Amazon. Activation and release rollback start the continuous consumer;
they therefore authorize queue and report-ledger writes plus the Amazon read/report operations of
the approved four job types. They do not authorize an Amazon advertising mutation. A future
authority-compatible lane handoff remains a separate reviewed and attended action.
