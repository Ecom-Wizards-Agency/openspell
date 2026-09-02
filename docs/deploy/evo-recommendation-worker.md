# Evo recommendation worker

This package stages and operates the dedicated, read-only recommendation preview claimant. It owns
only `recommendations.run`. It has no Ads API, SP-API, provider credential, scheduler, stale reaper,
export, apply, or Amazon mutation path. The existing integration and report workers remain active
and are never started, stopped, enabled, disabled, or reconfigured by these commands.

Every action below is a separate authorization. Merging this source authorizes none of them.

## Runtime boundary

The service receives one TPM-encrypted credential:

```text
openspell-recommendation-worker-database-url
```

It must authenticate directly as the narrow `openspell_recommendation_worker` principal. The
service never receives `service_role`. Authority transitions are instead performed by the fixed,
root-owned `/usr/local/libexec/openspell-recommendation-authority` broker. Its interface is:

```text
openspell-recommendation-authority block <expected-epoch> <old-revision-or-dash> <target-revision>
openspell-recommendation-authority activate <expected-epoch> <old-revision-or-dash> <target-revision>
openspell-recommendation-authority rebind <expected-epoch> <old-revision> <target-revision>
openspell-recommendation-authority authorize <expected-epoch> <current-revision> <current-revision>
```

The broker returns one bounded JSON decision and no credential or private value. Deployment code
invokes it exactly once per compare-and-set. Whether the broker reports success, failure, or loses
its response, the narrow credential then reads the exact authority tuple. Only the exact old tuple
or exact expected new tuple is actionable. A foreign tuple or unavailable readback stops both paths
for attended reconciliation; the CAS is never retried blindly.

## Immutable stage

Staging requires its own exact authorization. From a clean checkout whose `HEAD` and `origin/main`
both equal the approved full revision, run:

```bash
bash docs/deploy/install-recommendation-worker-evo-systemd.sh --revision <full-origin-main-revision>
```

The build produces a standalone Node bundle and a recorded source graph. It rejects any Ads API,
SP-API, broad worker/store/scheduler, provider package, credential locator, or checkout path. It
installs only `/opt/openspell-recommendation-worker/releases/<revision>`. It does not create or
change `current`, install a unit, reload systemd, enable a service, or change service state.

## First activation

Initial activation requires the hosted migration, narrow credential, root-owned authority broker,
and immutable release to have been independently authorized and verified. Run:

```bash
bash docs/deploy/activate-recommendation-worker-evo-systemd.sh --revision <full-origin-main-revision>
```

The transition serializes locally, snapshots the integration/report worker states, blocks
recommendation admission by compare-and-set, and starts the candidate with
`WORKER_CLAIM_ARMED=0`. Standby health proves loopback reachability, exact release/role/protocol/job
set, the narrow database credential, and zero claimant activity. It then attempts the fenced
authority CAS. If exact readback proves the new tuple, the service is stopped, switched to its
immutable armed unit (`WORKER_CLAIM_ARMED=1`), and must become healthy before activation succeeds.

If queued, running, token-bearing, or otherwise unresolved recommendation work exists, the database
refuses fencing. Admission remains blocked and the candidate is stopped. Re-running later is a new,
attended action based on a fresh tuple; it is not an automatic retry.

## Scoped admission

Scoped admission is a separate, exact authorization after the compatible web revision is live. It
uses the narrow read-only cutover-evidence RPC before and after one broker CAS; it never accepts a
broker response without exact database readback.

```bash
bash docs/deploy/authorize-recommendation-scoped-admission-evo.sh --revision <full-live-revision>
```

Preflight requires fenced/blocked authority for the exact live revision, zero queued, running or
token-bearing recommendation jobs, and zero invalid active scopes. Postflight requires
fenced/scoped authority, zero invalid active scopes, and at most the dedicated claimant's one
running token-bearing job. A response-loss or foreign tuple stops for attended reconciliation; the
command does not retry the CAS.

## Verification

Verify an armed service:

```bash
bash docs/deploy/verify-recommendation-worker-evo-systemd.sh <full-live-revision> --armed
```

Verify a deliberately unarmed candidate during an attended transition:

```bash
bash docs/deploy/verify-recommendation-worker-evo-systemd.sh <full-candidate-revision> --standby
```

Health is loopback-only and capability-free. It contains revision, role, protocol, the one job type,
authority protocol/admission/epoch and revision match, plus claimant ready/in-flight/failure state.
It never contains a worker id, database URL, claim id, token, tenant, profile, campaign, or error
detail.

## Compatible revision rebind and rollback

An upgrade and rollback use the same fenced-to-fenced operation. The destination must be a retained
artifact that implements `recommendation-fenced-v1`; protocol never returns to legacy.

```bash
bash docs/deploy/rollback-recommendation-worker-evo-systemd.sh <full-current-revision> <full-destination-revision>
```

The command blocks admission, proves the exact old authority, stops the source, starts the
destination in never-authorized standby, then invokes one revision-rebind CAS. Exact new readback
allows only the destination to arm. Exact old readback allows the compatible source to be restored.
Any other or unavailable readback leaves both revisions stopped. If the rebind committed but the
destination cannot arm, the old revision is not restarted because it no longer owns authority.

Rollback does not reverse a migration, reopen legacy claims, delete or requeue work, or reopen
optimizer admission. Admission remains blocked until the independent web-promotion and scoped-
admission gates are explicitly authorized and verified.

## Source proofs

The focused fixture/static proof performs no system or database action:

```bash
node docs/deploy/test-recommendation-worker-deployment.mjs
```

It checks exact public configuration, provider rejection, DB-only units, shell syntax, immutable
stage boundaries, source dependency reachability, strict broker output, scoped-admission evidence,
exact old/new response-loss classification, and ambiguous/foreign tuple refusal.
