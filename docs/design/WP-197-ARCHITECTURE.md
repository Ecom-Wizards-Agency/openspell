# WP-197 architecture: exact hosted migration bundle

Status: selected for implementation on 2026-09-03.

Base: `origin/main` at `f424a90b96c9ecacb5b21518cb29a8358c77f062`.

## Usage

After this package has merged and exact-main CI is green, an operator prepares a fresh, read-only
hosted-history snapshot in a disposable work directory. From a clean checkout whose `HEAD` and
local `origin/main` both equal the explicitly reviewed full revision, the local construction step
is:

```bash
pnpm migration:bundle -- build --history-workdir "$history_workdir" --output-workdir "$bundle_workdir" --revision "$revision"
pnpm migration:bundle -- verify --mode sealed --bundle-workdir "$bundle_workdir" --revision "$revision"
```

The builder emits exactly:

```text
<bundle workdir>/
  BUNDLE_MANIFEST.json
  supabase/
    migrations/
      <41 byte-preserved hosted-history files>
      <5 exact reviewed Git blobs>
```

Both commands print bounded JSON evidence. They do not accept a project reference, database URL,
credential, CLI version, target label, apply flag or arbitrary migration list. They do not invoke
Supabase, PostgreSQL, a browser, a secret manager, a provider or a network client.

Bundle construction is not permission to apply it. A later hosted action must name the exact source
revision, bundle-ledger digest, manifest digest, private target fingerprint, measured CLI executable,
held enqueue-freeze evidence and observed prefix-evidence digest. The operator must independently
prove fresh target ledger and dry-run state before receiving any apply command.

## Decision summary

WP-197 adds one narrow offline tool with `build` and `verify` operations. It treats the target's 41
already-applied files as an opaque, byte-authoritative prefix and reads the five pending files as
Git blobs from one exact reviewed revision. The output is new, gitignored, sanitized and
deterministic. It is published only after an independent verification pass closes filenames,
versions, byte counts, hashes, provenance and canonical ledger digests. A two-phase unpublished
marker makes every pre-commit crash remnant fail public verification.

The artifact itself contains no claim that its input was freshly fetched or belongs to a particular
hosted target. Those facts cannot be proved offline without reintroducing credentials or target
identifiers. A separate read-only operational gate must establish them immediately before any
later apply. This package constructs and verifies bytes; it does not connect those bytes to hosted
state.

## Grounded problem

The hosted migration ledger currently contains 41 versions through
`20260901010000_authenticated_relation_privilege_hardening.sql`. The source tree contains five
newer migrations, in strict order:

1. WP-187 `20260901020000_sp_write_persistence_ledger.sql`;
2. WP-192 `20260901030000_sp_write_outbox_delivery.sql`;
3. WP-194 `20260901040000_fenced_sync_claims.sql`;
4. WP-195 `20260901050000_recommendation_preview_scopes.sql`;
5. WP-196 `20260901060000_recommendation_claim_custody.sql`.

The hosted 41-file prefix is intentionally not a mirror of the current repository migration
directory. Historical versions were remapped, and legitimate hosted bytes differ from present
source bytes, including the hosted WP-186 file. Replacing those files from the repository, renaming
current files to hosted versions or replaying the fetched prefix on a fresh database would destroy
the exact ledger-compatible shape.

The available fetched work directory also contains mutable CLI linkage under `.temp`. Copying the
directory wholesale would mix credentials-adjacent target state with the migration artifact.
Supabase CLI commands can create that metadata even for apparently harmless operations, so the
sealed output must never be a CLI working directory.

Finally, the later five-file apply is forward-sequential, not one transaction. Each migration and
its ledger row commit independently. A transport failure can therefore leave any contiguous prefix
from 41 through 46 committed. Construction and later operations need exact prefix evidence rather
than trusting a process exit code.

## Architecture candidates

### Candidate A: connected fetch-and-apply orchestrator

Give one command a project reference, run `migration fetch`, assemble the suffix, run a dry run and
optionally apply it.

This can prove freshness in one process, but it combines read-only discovery, credentialed target
access and destructive application behind one interface. A parser or flag mistake would have
production reach, and the resulting manifest could accidentally retain target linkage.

Decision: rejected. Retain its fresh-target and dry-run evidence as a later, separately authorized
operational gate.

### Candidate B: checked-in target migration mirror

Commit the 41 fetched files plus the five pending files as a deployment tree and review the complete
directory in Git.

This makes the artifact easy to inspect but permanently duplicates target-specific historical
bytes, becomes stale as soon as the ledger advances and blurs source migrations with deployment
evidence. It also raises the chance that `.temp` or target metadata enters the public repository.

Decision: rejected. The generated bundle remains outside the repository and carries only a
sanitized deterministic manifest.

### Candidate C: offline fixed-policy builder and verifier

Accept an operator-supplied history work directory, an exact full Git revision and a new output work
directory. Validate the known 41-file prefix without replacing it, extract only the fixed five Git
blobs, publish one minimal tree and independently verify it.

This keeps callers out of ordering, renaming, hash and copy policy while leaving hosted access and
application impossible. Its one limitation is deliberate: freshness and target identity must be
proved later against the live target.

Decision: selected.

## Public interface

The implementation exposes two operations and a bounded evidence shape:

```ts
interface BuildBundleOptions {
  readonly historyWorkdir: string;
  readonly outputWorkdir: string;
  readonly sourceRevision: string;
}

interface VerifyBundleOptions {
  readonly bundleWorkdir: string;
  readonly sourceRevision: string;
  readonly mode: "sealed" | "cli-workdir";
}

interface BundleEvidence {
  readonly status: "verified";
  readonly artifactMode: "sealed" | "cli_workdir";
  readonly sourceRevision: string;
  readonly baselineFiles: 41;
  readonly addedFiles: 5;
  readonly totalFiles: 46;
  readonly totalBytes: 646628;
  readonly lastVersion: "20260901060000";
  readonly baselineLedgerSha256: string;
  readonly bundleLedgerSha256: string;
  readonly manifestSha256: string;
}

export async function buildHostedMigrationBundle(
  options: BuildBundleOptions,
): Promise<BundleEvidence>;

export async function verifyHostedMigrationBundle(
  options: VerifyBundleOptions,
): Promise<BundleEvidence>;
```

The CLI accepts only the documented flags, refuses duplicates and unknown arguments, and emits one
JSON value on success. `sealed` mode requires the root to contain only the exact manifest and
`supabase/migrations` tree. `cli-workdir` mode permits exactly one additional relative entry,
`supabase/.temp`, which must be a directory. It does not traverse or read that directory. Every
other extra root or `supabase` entry is rejected, including `config.toml`, seeds, hooks, functions
and arbitrary files. It still requires an exact migration tree and manifest and labels the evidence
`cli_workdir`. Both modes explicitly reject the unpublished marker. Errors are bounded and must not
echo paths, environment values, SQL bytes or subprocess output.

`build` always verifies its marked output before the publication commit point. `verify`
independently rereads the completed artifact and the five Git blobs at the claimed revision. The
implementation keeps Git extraction, canonical encoding, filesystem custody, exclusive output
claiming and hashing inside the module rather than asking the caller to coordinate them.

## Exact byte policy

The 41-file baseline has these fixed aggregate properties:

```text
file count       41
byte count       279677
last version     20260901010000
ledger SHA-256   9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea
```

The five additions are:

| Version | Bytes | SHA-256 |
|---|---:|---|
| `20260901020000` | 179749 | `d28e2c3630ac4b59732cde8bb7021ae955c9b36f0b58d0567a7751c14259df67` |
| `20260901030000` | 46611 | `c34fc0a1902abe27f0c33d66c1a083fb32f0fd5df30974baecace674a2219a2c` |
| `20260901040000` | 20101 | `ec96b16f6c2c487404ee15d24cdf58d40d2d079ed0ed12fd5b12bc7abbcd9bf2` |
| `20260901050000` | 6379 | `af126c432ca8d523d7483139de3cbf267f3c1d2c68a14b236f2b171fc3811021` |
| `20260901060000` | 114111 | `937fe566de09413df7a7578bcd3889c36d4465b81c6d03ad0a1773ca3cf0cb84` |

The complete bundle has 46 files, 646628 bytes, terminal version `20260901060000` and ledger digest
`baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`.

For each directory, the canonical ledger preimage is UTF-8:

```text
openspell.hosted-migration-ledger.v1\n
<ordinal>\t<version>\t<filename>\t<byte-count>\t<sha256>\n
...
```

Filenames are ASCII, rows are sorted by filename bytes, ordinals start at one and the final row has
a terminal line feed. This domain-separated digest is the contract; ad hoc concatenations or
alternate manifest digests are not interchangeable with it.

## Source and filesystem custody

The builder requires:

- a full lowercase 40-hex revision;
- a clean repository checkout with `HEAD`, local `origin/main` and the requested revision equal;
- exact hashes for the five repository paths at that revision;
- an existing history work directory whose `supabase/migrations` contains exactly the fixed 41
  regular `.sql` files;
- a non-existent output path outside the repository and outside the history input.

It reads additions with a fixed `git cat-file` operation. It never reads the working-tree migration
bytes. The Git invocation accepts no caller-controlled option or repository path beyond the already
validated full object id and fixed internal paths.

The history scan does not traverse or read `.temp`, configuration or any sibling of
`supabase/migrations`. Inside the migration directory it refuses symlinks, non-regular files,
hard-linked inputs, missing or extra files, duplicate versions, changed bytes and filename or order
drift. It snapshots verified input bytes before creating output so a later input mutation cannot
change the copied artifact.

Path checks canonicalize the repository, input and every existing output ancestor before comparing
containment or overlap. The reader opens each accepted input with no-follow semantics, then checks
the opened descriptor's type, link count, device and inode against the inspected entry before and
after reading. A path swap or byte change fails the build rather than changing the snapshot.

After snapshotting every accepted input byte, construction atomically claims the non-existent
requested output with exclusive directory creation while holding the canonical parent-directory
descriptor. On Linux it creates the basename through `/proc/self/fd/<parent-fd>/`, immediately opens
and retains the claimed output-directory descriptor, and rechecks both canonical pathname bindings
against their held device/inode identities. This no-replace claim refuses a destination created
concurrently. Every post-claim marker, payload, private-verification and sync operation is rooted at
`/proc/self/fd/<output-fd>/`, not at the caller-visible output pathname. The tool creates a fixed
`.BUNDLE_UNPUBLISHED` marker before any payload file, writes the 46 SQL files and
`BUNDLE_MANIFEST.json`, and rechecks both descriptor and canonical-path custody around private
marked-tree verification. Public `verify` always rejects the marker. Descriptor-relative marker
removal followed by an output-directory sync is the publication commit point.

`build` therefore requires Linux with a mounted, usable `/proc/self/fd`; it fails closed before
output construction on another platform or when descriptor-relative access is unavailable. Public
`verify` does not depend on the construction protocol and may remain portable.

A crash before the marker is created can leave only an empty, unverifiable requested directory. A
crash after marker creation but before marker removal leaves a marked requested output. Neither can
pass public verification, and the builder never recursively deletes a path after losing custody.
A crash or lost response after marker removal may leave a valid published bundle. The caller
reconciles that outcome by running `verify` against the requested output and never rebuilds or
deletes it blindly. Existing output, parent/output identity substitution, overlapping paths and
repository-contained build or verification roots are refused.

The sealed output is not made into a Supabase work directory. Any later CLI dry run operates on a
fresh writable clone. After the dry run and again immediately before apply, `verify --mode
cli-workdir` rehashes the clone's exact migration tree and manifest while ignoring rather than
trusting CLI-owned `.temp` siblings. The clone is discarded after its separately authorized
evidence capture or apply.

For an apply, the guarded writer creates the CLI clone in its own private mode-`0700` directory,
which the caller and coding-agent processes cannot access. After the dry run, it makes the manifest
and every migration file read-only and the migration directories non-writable; only
`supabase/.temp` remains writable for the CLI. It holds exclusive clone custody from the final byte
verification until the CLI child exits. The guarded code has no write path to the manifest or
migration tree during that interval. A caller-supplied or shared writable clone is never eligible
for apply.

## Manifest and evidence

`BUNDLE_MANIFEST.json` is deterministic and contains:

- schema version and `construction_and_review_only` purpose;
- exact source revision;
- baseline and complete file counts, byte counts, terminal versions and ledger digests;
- the five fixed additions with work package, repository path, size and hash;
- all 46 migrations with ordinal, version, filename, size, hash and either `hosted_baseline` or
  `reviewed_git_blob` provenance.

The exact key order is:

```json
{
  "schemaVersion": "openspell.hosted-migration-bundle.v1",
  "purpose": "construction_and_review_only",
  "sourceRevision": "...",
  "baseline": {
    "fileCount": 41,
    "byteCount": 279677,
    "lastVersion": "20260901010000",
    "ledgerSha256": "..."
  },
  "additions": [
    {
      "workPackage": "WP-187",
      "repositoryPath": "supabase/migrations/20260901020000_sp_write_persistence_ledger.sql",
      "version": "20260901020000",
      "byteCount": 179749,
      "sha256": "..."
    }
  ],
  "bundle": {
    "fileCount": 46,
    "byteCount": 646628,
    "lastVersion": "20260901060000",
    "ledgerSha256": "..."
  },
  "migrations": [
    {
      "ordinal": 1,
      "version": "20260813183448",
      "filename": "20260813183448_20260813120000_platform.sql",
      "byteCount": 6553,
      "sha256": "...",
      "provenance": "hosted_baseline"
    }
  ]
}
```

The manifest uses UTF-8 without a byte-order mark, two-space JSON indentation and one terminal line
feed. The implementation constructs every object in the documented key order and every array in
canonical migration or addition order, then serializes it with `JSON.stringify(value, null, 2)`.
Numbers are base-10 JSON integers and all strings are ASCII under the fixed policy. The verifier
rejects missing, extra or reordered keys and reserializes the parsed value to prove exact canonical
bytes.

It contains no timestamp, absolute path, project reference, database URL, target label, target
fingerprint, CLI version, environment value or SQL body. Those would either make deterministic
verification impossible or claim an external fact that the offline builder cannot prove.

The verifier hashes the exact manifest bytes and returns that digest in `BundleEvidence`. A later
authorization tuple can therefore bind the immutable source revision, bundle ledger and manifest
without exposing target identity publicly.

The later private target fingerprint accepts one exact ASCII project reference matching
`[a-z]{20}`. It does not trim or case-normalize input. The fingerprint is SHA-256 over
`openspell.hosted-target.v1\n<project-ref>\n`. Its preimage stays in the attended or guarded channel
and never enters Git, the public bundle or agent logs. Every private operational evidence record
carries that same digest. A target with an otherwise identical 41-version ledger cannot reuse
another target's authorization.

Both dry run and apply receive that exact validated project reference through an explicit
`--project-ref` argument. Default or linked target selection is forbidden. The private evidence
binds `targetSelectionSha256`, computed over the ASCII bytes
`openspell.supabase-target-selection.v1\n--project-ref\n<project-ref>\n`. The raw argument record stays
private. Mutable `supabase/.temp` linkage can neither select nor replace the authorized target.

## Later preflight, apply and recovery contract

WP-197 provides a reviewed transaction-read-only catalog/ledger probe plus six prefix-specific
evidence scripts for later preflight, postflight and ambiguous-response reconciliation. The probe
runs at every prefix from 41 through 46 and selects exactly one static prefix script. A prefix script
references only relations guaranteed to exist at that prefix, so PostgreSQL never has to parse a
reference to a not-yet-created relation. The scripts return aggregate counts, fixed authority
tuples, bounded catalog properties and fingerprints only. They contain no target locator, dynamic
SQL or write.

The no-parameter probe also returns separate counts for other granted and waiting holders of the
shared schema-DDL advisory key. It counts every lock with a null backend id and excludes only its own
backend id, which permits the future guarded runner to execute it on the same session that holds the
guard described below. It separately counts all database sessions whose application name has the
fixed `os-wp197-cli-` prefix, plus the active and lock-waiting subsets. These are aggregate public-safe
observations; the probe never returns a backend id, application name, query, user, address or target.
A passing standalone probe is one instant of evidence. It does not identify a session, establish
custody, eliminate a later race or authorize any action.

The future runner represents the probe's one row as this exact canonical JSON key order and hashes
its UTF-8 bytes with SHA-256. No timestamp or private identity is added to this public row:

```json
{
  "schemaVersion": "openspell.hosted-migration-probe-evidence.v1",
  "observedPrefixFiles": 41,
  "observedTerminalVersion": "20260901010000",
  "observedPrefixLedgerSha256": "...",
  "selectedEvidenceScript": "wp-197-hosted-migration-prefix-41.sql",
  "catalogPatternPass": true,
  "schemaDdlLockHolderCount": 0,
  "schemaDdlLockWaiterCount": 0,
  "guardedCliSessionCount": 0,
  "guardedCliActiveCount": 0,
  "guardedCliWaitingCount": 0,
  "pass": true
}
```

The canonicalization uses the manifest's JSON rules. Field type, order, presence and exact value are
closed; an extra, missing, null, duplicated or differently typed result refuses. The two guarded
probe observations must therefore produce the same digest as well as the same typed values.

A later operator action must rebuild from a fresh read-only fetched snapshot, then independently
prove:

- one private target fingerprint, derived from the canonical target locator, carried unchanged by
  the history-fetch, preflight, dry-run, apply authorization, apply, reconcile and postflight
  evidence without recording its raw locator in Git;
- Supabase CLI `2.116.0` plus the executable's SHA-256 and immutable installation provenance, with
  the same broker-private measured executable copy used for dry run and apply;
- exactly the 41 ordered hosted versions through `20260901010000` before apply;
- a dry run offers exactly versions `20260901020000` through `20260901060000`, in order;
- a post-dry-run and immediate pre-apply `verify --mode cli-workdir` result proving that the writable
  CLI clone still has the authorized source revision, manifest digest and bundle-ledger digest;
- no migration object collision, blocking lock, unsafe long transaction or incompatible active
  recommendation work exists;
- every relation, role and authority object introduced by the five pending migrations is absent;
- the existing recommendation producer and queue state is compatible with the documented enqueue
  freeze, while static source review proves the pending migrations install legacy-default report
  and recommendation authority and inert SP write state.

Before final preflight, a separate exact authorization must establish and hold the reviewed
recommendation-enqueue freeze. Its evidence names the mechanism and proves its state, disposes or
drains active work under an explicit decision, and captures the exact queue fingerprint. The freeze
stays held through dry run, apply, any ambiguity reconciliation and postflight. Only then may the
apply authorization be issued. WP-196 removes the generic scheduler's `recommendations.run` path
immediately even though admission initially remains legacy, so ordering is load-bearing. Database
apply authority does not authorize stopping or changing a service, changing credentials, staging a
worker, activating fenced authority, authorizing scoped admission or deploying web.

The probe and selected prefix script are separate transactions. An unguarded
`probe -> prefix -> probe` sandwich must require both probe rows to agree on prefix count, terminal
version, prefix digest and selected script, and both must report zero other schema-DDL holders,
waiters and tagged CLI sessions. That sandwich detects a committed prefix change across its
observations but does not close either gap around the prefix transaction. It remains review evidence
only and is never eligible for an apply or suffix authorization. A passing result also cannot rule
out an actor that ignores both the broker target lock and the shared advisory key; that is an
operational exclusivity precondition, not a fact this public SQL can prove.

The future guarded runner closes those gaps with a private database guard session. While holding its
separate broker target lock, it opens one target-bound connection, records its backend id and backend
start, and uses a bounded non-waiting attempt to acquire the session-level advisory lock on the exact
`wizard-ads:schema-ddl:v1` key. Failure to acquire refuses. The runner keeps that connection and lock
under custody, then runs the probe, selected prefix script and second probe on that same connection.
The prefix script's rollback does not release the session-level lock. The public probe excludes only
its own guard backend, so any other granted or waiting holder still fails. Both probe results must be
byte-identical, including prefix selection and all activity counts, and the prefix evidence must
agree with the authorized leaves. Connection loss, lock loss, a changed backend identity or any
observation mismatch makes the outcome ambiguous and blocks action. This guarded protocol is a
contract for a later private runner; neither the public SQL nor WP-197's offline tool implements it.

The CLI does not know the private advisory-key protocol, so that advisory lock alone is not a child
barrier. Immediately before spawn, the guard session begins a short transaction and acquires
`ACCESS EXCLUSIVE` on the already-existing `supabase_migrations.schema_migrations` relation with a
bounded non-waiting attempt. Failure refuses. The future runner then spawns the exact measured CLI
child with the private operation's fixed application name. Before releasing the relation barrier, it
must observe exactly one matching target backend whose ungranted relation lock is blocked solely by
the recorded guard backend. Exact CLI `2.116.0` disposable proof must establish the requested lock
mode as exactly `AccessShareLock` and prove the reviewed invocation reaches this ledger read before
any statement capable of applying a migration.

The runner binds that backend id and backend start to the already-owned child process and private
target. No untagged or additional matching session or blocker may exist. If the tag is absent,
duplicated, not waiting on that exact relation, or has any other blocker, the runner terminates the
still-blocked child and proves both process and session termination before ending the barrier
transaction. Uncertainty leaves both locks held and requires attended recovery. Committing the
short barrier transaction after a valid handoff is the first point at which the child can execute
migration SQL. The session-level schema-DDL guard and broker target lock remain held through child
termination, reconciliation and postflight; they are not the barrier released at handoff. Loss of
the guard connection during handoff or apply is an ambiguous apply outcome, never proof that nothing
ran.

The session tag is derived inside the guarded operation from its independently generated operation
id and nonce. Its exact form is `os-wp197-cli-` followed by the first 48 lowercase hexadecimal
characters of SHA-256 over
`openspell.hosted-migration-session.v1\n<operation-id>\n<authorization-nonce>\n`. The complete name is
61 ASCII bytes, below PostgreSQL's application-name limit. The raw tag stays in guarded memory and
private evidence. `databaseSessionTagSha256` is SHA-256 over the complete 61 ASCII tag bytes, and the
private operation envelope carries only that digest. The exact CLI `2.116.0` disposable proof must
show that the reviewed invocation channel applies this name to every database connection; if it
cannot, this handoff contract is unavailable and no production apply may use it.

If an apply response is lost, only the read-only reconciler may run. The private operation ledger
must first prove the exact child process terminal. If the host or supervisor outcome is uncertain,
recovery stays blocked until attended process inspection proves that child cannot still run. The
runner then validates the still-held database guard or, if its loss has already made the outcome
ambiguous, reacquires it non-waitingly under attended recovery. It requires zero sessions with the
exact private application name and runs the guarded probe/prefix/probe sandwich. Only this combined
private evidence may identify one exact contiguous prefix from 41 through 46. The public probe alone
makes no matching-session claim. Recovery is forward-only. Any remaining suffix requires a new dry
run, operation id, nonce, session tag, evidence and exact operator authorization. Blind retry,
migration repair, reverse SQL and replay of an already-applied file are forbidden.

The probe and six prefix scripts implement this fixed matrix. Each prefix script has the named
canonical bundle-prefix digest plus an exact object, function, trigger, policy, ownership, ACL,
role and row-fingerprint expectation in source. It emits ASCII `(check_key, expected, observed,
pass)` rows and accepts no existence-only shortcut. The guarded runner refuses to select a prefix
script unless the probe returns exactly its file count, terminal version and required
presence/absence catalog pattern.

| Files | Terminal version | Canonical ledger SHA-256 | Required state |
|---:|---|---|---|
| 41 | `20260901010000` | `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea` | Every WP-187/WP-192/WP-194/WP-195/WP-196 object is absent; original queue and recommendation fingerprints close. |
| 42 | `20260901020000` | `82fa9aea16b9d44a4b0bc82111a5ab960246a9c9a970fa86182b8aa36632413e` | Exact WP-187 schema/ACL set exists; every new row-bearing relation is empty. |
| 43 | `20260901030000` | `d1359b1fd9dfa5b1ed8c6669df8323a35b4684fbbb3d7a0fc739488aee1d9530` | Exact WP-192 custody objects exist; outbox heads close one-for-one against the preserved outbox rows and custody events are empty. |
| 44 | `20260901040000` | `0e408d86b6fad5713e459b4369bbf5a6c39a3174c4ea6845bfb1ca262de647b1` | Exact WP-194 fenced-report objects exist; all claim tokens are null and report authority is `legacy`, epoch zero. |
| 45 | `20260901050000` | `ac7e960282c6f7d999656eb0f0a87ca84deef772b5c9fa974cd75b7893a44a5b` | Exact WP-195 scope objects exist; preview batches/scopes are empty and all historical scope/custody columns remain null. |
| 46 | `20260901060000` | `baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458` | Exact WP-196 custody, scheduler, role, ownership, ACL and policy matrix exists; recommendation authority is `legacy/legacy`, epoch zero, with no authorized revision. |

Each prefix also requires unchanged preflight queue/recommendation fingerprints and the absence of
objects owned by a later prefix. SQL-observed rows are sorted by ASCII `check_key`, must have unique
keys and may contain only printable ASCII without tab, carriage return or line feed. The canonical
prefix-evidence preimage is:

```text
openspell.hosted-prefix-evidence.v1\n
<ordinal>\t<key-byte-count>\t<check-key>\t<expected-byte-count>\t<expected>\t<observed-byte-count>\t<observed>\t<true-or-false>\n
...
```

Ordinals start at one, byte counts are unpadded decimal UTF-8 lengths, and the final row has a line
feed. SHA-256 over those bytes is `prefixEvidenceSha256`.

At prefixes 42 through 46, zero-row evidence explicitly covers every WP-187 row-bearing relation:

```text
sp_write_environment_gate_versions
sp_write_environment_gate_head
sp_write_profile_grant_versions
sp_write_profile_grant_heads
sp_write_bounded_authorizations
sp_write_bounded_authorization_profiles
sp_write_bounded_authorization_entities
sp_write_bounded_authorization_revocations
sp_write_bounded_authorization_consumptions
sp_write_plans
sp_write_plan_actions
sp_write_approval_requests
sp_write_execution_cycles
sp_write_authorization_receipts
sp_write_cycle_plans
sp_write_execution_requests
sp_write_dispatch_leases
sp_write_predispatch_observations
sp_write_predispatch_observation_items
sp_write_predispatch_dispositions
sp_write_provider_call_intents
sp_write_provider_call_positions
sp_write_action_resolutions
sp_write_provider_results
sp_write_provider_result_positions
sp_write_outbox
sp_write_observations
sp_write_late_result_audits
```

At prefixes 43 through 46, `app.sp_write_outbox_delivery_events` must also have zero rows.
`app.sp_write_outbox_delivery_heads` is the only permitted non-empty new relation; its count and
one-for-one identity/state fingerprint must close against the preserved `public.sp_write_outbox`
rows.

The SQL accepts no target, CLI, freeze or expected-fingerprint argument. It observes database state
and returns rows plus `prefixEvidenceSha256`. Every prefix script also returns these exact named
ASCII fields: `queueFingerprint`, `recommendationFingerprint`, `scheduleFingerprint` and
`outOfScopePrivilegeFingerprint`. The guarded runner places them in this canonical leaf before
hashing it:

```json
{
  "schemaVersion": "openspell.hosted-database-evidence.v1",
  "phase": "preflight",
  "targetFingerprint": "...",
  "observedPrefixFiles": 41,
  "observedPrefixLedgerSha256": "...",
  "prefixEvidenceSha256": "...",
  "queueFingerprint": "...",
  "recommendationFingerprint": "...",
  "scheduleFingerprint": "...",
  "outOfScopePrivilegeFingerprint": "..."
}
```

`phase` is exactly `preflight` or `current_prefix`. Before it creates an operational envelope, the
runner compares the four named current-prefix fields to the stored preflight leaf by exact string
equality and emits this canonical comparison:

```json
{
  "schemaVersion": "openspell.hosted-state-comparison.v1",
  "preflightEvidenceSha256": "...",
  "currentPrefixEvidenceSha256": "...",
  "queueFingerprintMatch": true,
  "recommendationFingerprintMatch": true,
  "scheduleFingerprintMatch": true,
  "outOfScopePrivilegeFingerprintMatch": true,
  "allMatch": true
}
```

Any false or missing comparison refuses envelope creation. Hashing two leaves side by side is not a
substitute for comparing their named target-specific values.

A private attended evidence envelope binds the database result and comparison to facts outside SQL.
It uses the same canonical JSON rules as the public manifest and this exact key order:

```json
{
  "schemaVersion": "openspell.hosted-migration-operation.v1",
  "operationKind": "initial_apply",
  "operationId": "...",
  "authorizationNonce": "...",
  "issuedAt": "...",
  "expiresAt": "...",
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "sourceRevision": "...",
  "manifestSha256": "...",
  "bundleLedgerSha256": "...",
  "cliVersion": "2.116.0",
  "cliBinarySha256": "...",
  "cliExecutableIdentitySha256": "...",
  "cliInstallProvenanceSha256": "...",
  "historyFetchEvidenceSha256": "...",
  "preflightEvidenceSha256": "...",
  "stateComparisonEvidenceSha256": "...",
  "enqueueFreezeEvidenceSha256": "...",
  "dryRunEvidenceSha256": "...",
  "postDryRunCliWorkdirEvidenceSha256": "...",
  "preApplyCliWorkdirEvidenceSha256": "...",
  "preApplyTargetEvidenceSha256": "...",
  "preApplyFreezeEvidenceSha256": "...",
  "schemaDdlGuardEvidenceSha256": "...",
  "databaseSessionTagSha256": "...",
  "observedPrefixFiles": 41,
  "observedPrefixLedgerSha256": "...",
  "prefixEvidenceSha256": "..."
}
```

`operationKind` is exactly `initial_apply` or `suffix_apply`. The guarded operation generates
`operationId` and `authorizationNonce` independently as 256 cryptographic-random bits and encodes
each as 64 lowercase hexadecimal characters. Callers cannot supply them. The private ledger has
separate unique constraints for both values; a collision refuses rather than regenerating inside
the request. `issuedAt` and `expiresAt` are UTC RFC 3339 timestamps with whole seconds and `Z`;
expiry is at most 15 minutes after issue. Each of the two CLI-workdir leaf records
uses canonical JSON to bind the same operation id and nonce, its exact phase
(`post_dry_run` or `pre_apply`), an observation timestamp, and the complete deterministic
`BundleEvidence`. Thus the deterministic verifier output cannot stand in for two fresh phase
observations.

The guarded runner creates the database session tag before dry run and binds its SHA-256 into the
envelope. It passes the raw tag only through the reviewed `PGAPPNAME` environment entry to the exact
private CLI child. The child environment is an exact allowlist; callers cannot add, replace or read
the tag. Disposable proof against the exact CLI binary must demonstrate that every connection it
opens carries the complete, untruncated value. Merely setting the environment entry without observing
the database session is not proof.

`schemaDdlGuardEvidenceSha256` hashes this canonical private leaf, with the same JSON serialization
rules and key order used by the envelope:

```json
{
  "schemaVersion": "openspell.hosted-schema-ddl-guard.v1",
  "phase": "pre_apply",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "databaseSessionTagSha256": "...",
  "guardBackendPid": 123,
  "guardBackendStart": "...",
  "acquiredAt": "...",
  "firstProbeObservedAt": "...",
  "firstProbeEvidenceSha256": "...",
  "prefixObservedAt": "...",
  "prefixEvidenceSha256": "...",
  "secondProbeObservedAt": "...",
  "secondProbeEvidenceSha256": "...",
  "otherSchemaDdlHolderCount": 0,
  "otherSchemaDdlWaiterCount": 0,
  "guardedCliSessionCount": 0
}
```

The backend id is a positive PostgreSQL process id and all four time fields use the same whole-second
UTC format as the envelope. `acquiredAt` records the start of continuous custody. The three
observation times are written only after their respective query result has been fully received, are
monotonic in the listed order, and `secondProbeObservedAt` measures freshness. The two probe hashes
bind their complete canonical single-row records, not selected fields, and must be equal. Both probe
rows must select the same prefix and carry zero values for all five activity counts. The second probe
observation must be less than 60 seconds old at authorization, and the connection, backend identity
and session-level lock must remain live through nonce consumption and the final pre-spawn checks.

Before dry run, the guarded operation resolves the reviewed CLI installation once, copies the
executable into its private mode-`0700` operation directory, makes the copy non-writable and records
its fixed relative path, device, inode, byte count, SHA-256, `2.116.0` version output and installation
provenance in a canonical private executable-identity leaf. Dry run runs that exact absolute private
copy, never `PATH`, a symlink or a wrapper. The copy stays under exclusive guarded custody through
apply.

The `pre_apply` observation must be less than 60 seconds old when attended authorization is issued.
The pre-apply target leaf binds the operation id and nonce, `pre_apply` phase, observation time,
target fingerprint, observed prefix count and ledger digest, `prefixEvidenceSha256`, and
`stateComparisonEvidenceSha256`. The pre-apply freeze leaf binds the same operation identity and
phase, observation time, target fingerprint, reviewed freeze mechanism and generation, held state,
producer-admission state, active recommendation-job count and queue fingerprint. Both must be less
than 60 seconds old at authorization.

After consuming the nonce and before spawning the CLI, the guarded writer performs the last
pre-spawn checks in this order: verify the same target-bound database guard connection, backend
identity and session-level lock; reopen the private CLI copy without following links; remeasure its
path, device, inode, bytes, hash, version and provenance; derive the target fingerprint and target-
selection digest from the same canonical project-ref preimage; rerun the guarded probe/prefix/probe
sandwich on the guard connection; compare the four named fingerprints to preflight; recheck the held
freeze; and run `verify --mode cli-workdir`. Every invariant value must equal the matching authorized
leaf, including the complete deterministic `BundleEvidence`. The writer records new observation times
in the private ledger. Any guard, executable, target, ledger, object, role, ACL, row, queue, freeze or
byte change refuses before child creation.

The writer then opens the short transaction-held migration-ledger relation barrier and spawns that
exact private executable by its already canonicalized absolute path, with the bound application name,
and passes the exact validated project reference explicitly with `--project-ref`. It never resolves
`PATH` again and never permits linked or default target selection. Private directory ownership and
non-writable executable bytes prevent a path or binary swap between the final measurement and process
creation. The relation barrier remains held until the exact waiting-session handoff succeeds; the
session-level database guard remains held after the barrier is released.

The guarded operation writes the envelope only to private evidence storage and reports its SHA-256
for attended authorization. Apply authorization names that envelope digest. Before invoking the
measured CLI binary, the guarded writer atomically marks the authorization nonce consumed in its
private single-use ledger. An expired or already-consumed nonce refuses without spawning the CLI.
Failure after consumption requires read-only reconciliation and a new authorization; it never
reuses or resets the nonce.

Before relation-barrier release, the operation ledger appends one canonical private session-binding
leaf:

```json
{
  "schemaVersion": "openspell.hosted-migration-session-binding.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "databaseSessionTagSha256": "...",
  "cliChildPid": 456,
  "cliChildStart": "...",
  "guardBackendPid": 123,
  "guardBackendStart": "...",
  "cliBackendPid": 789,
  "cliBackendStart": "...",
  "blockedRelation": "supabase_migrations.schema_migrations",
  "requestedLockMode": "AccessShareLock",
  "blockingBackendPids": [123],
  "state": "waiting",
  "waitEventType": "Lock",
  "observedAt": "..."
}
```

The runner accepts exactly one matching backend at handoff, requires its application name to hash to
the authorized tag digest, proves its ungranted relation-lock row names the fixed migration-ledger
relation and exact lock mode established by disposable proof, and requires its only blocking backend
to be the recorded guard. The only accepted mode is `AccessShareLock`; a different exact-CLI
observation changes the architecture and must return to review. It records the leaf before releasing
the relation barrier and monitors
every later backend with that exact tag until the child is terminal. This post-spawn leaf is an audit
result, not a value that can be predicted and inserted into the pre-spawn authorization envelope.

A remaining-suffix authorization always uses `suffix_apply`, a new operation id and nonce, and a
new envelope with the newly observed prefix file count, ledger digest and
`prefixEvidenceSha256`. This remains true when an ambiguous response reconciles to the same prefix
as before.

Full postflight must prove at least:

- all five new ledger versions exist in order;
- SP write authority, execution, intent and outbox tables remain empty;
- outbox head counts close exactly against pre-existing rows and outbox events remain empty;
- all new report claim tokens remain null and report authority is `legacy`, epoch zero;
- recommendation preview batches and scopes remain empty;
- recommendation authority is `legacy/legacy`, epoch zero, with no authorized revision;
- both recommendation roles remain `NOLOGIN`, non-inheriting, non-superuser and non-bypass, with
  only the exact reviewed function set;
- both roles also remain `NOCREATEROLE`, `NOCREATEDB` and `NOREPLICATION`, with null password
  verifier, null `VALID UNTIL` and connection limit `-1`;
- `pg_auth_members` contains no edge where either narrow role is a member and no incoming edge other
  than the managed migration creator's non-inheriting, non-SET bootstrap metadata allowed by the
  migration;
- the exact privilege transition matrix closes every expected addition, removal and replacement,
  including function ownership, schema/table/sequence grants, default ACLs, executor-specific RLS
  policies, WP-194's `sync_jobs` table-SELECT removal and safe column grants, and WP-196's removal of
  ambient `PUBLIC` execute from the two existing RPCs;
- existing queues, recommendations, schedules, touched relation fingerprints and every out-of-scope
  ACL, RLS policy and default privilege close byte-for-byte against preflight;
- new SP execution and outbox state is empty and existing OpenSpell provider/write ledgers are
  unchanged;
- static capability evidence proves neither the bundle tool nor the read-only evidence scripts can
  invoke a provider or Amazon operation. This evidence makes no claim about actions by unrelated
  external actors.

## Module layout

```text
tools/hosted-migration-bundle/
  package.json
  tsconfig.json
  sql/
    wp-197-hosted-migration-probe.sql
    wp-197-hosted-migration-prefix-41.sql
    wp-197-hosted-migration-prefix-42.sql
    wp-197-hosted-migration-prefix-43.sql
    wp-197-hosted-migration-prefix-44.sql
    wp-197-hosted-migration-prefix-45.sql
    wp-197-hosted-migration-prefix-46.sql
  src/
    bundle.ts
    bundle.test.ts
    cli.ts
docs/deploy/
  hosted-migration-bundle.md
```

`bundle.ts` is the deep module: fixed policy, branded validation, canonical ledger encoding, Git
blob reading, crash-safe construction and independent verification. `cli.ts` is a strict adapter.
The SQL and runbook are inert review artifacts for later action-specific gates.

No generic specification file, custom addition list, filename mapping, copy mode, destination
layout or apply command is exposed. This is one fixed release capability, not a general migration
deployment framework.

## Proof strategy

Focused tests must prove:

- exact 41-plus-5 construction and deterministic repeated evidence;
- source bytes come from the pinned Git object despite a modified working-tree copy;
- refusal of a wrong, abbreviated, missing or non-main revision;
- refusal of missing, changed, renamed, duplicate, extra or out-of-order baseline input;
- refusal of a changed or missing pending Git blob;
- refusal of symlinks, non-regular files, hard links, overlapping paths, repository-contained output
  and existing output;
- input mutation, output mutation and manifest mutation cannot verify;
- injected failure before publish leaves no verifiable output;
- exact manifest keys, ordering, provenance, counts, sizes and digests;
- `.temp` and every non-migration input are absent from output;
- static dependency and command inspection finds no Supabase, PostgreSQL, network, provider,
  credential, deployment or apply capability;
- the universal probe and all six prefix scripts have no mutating or dynamic statement and return
  bounded public-safe evidence;
- Linux construction claims the output beneath a held parent descriptor, retains the output
  descriptor for every later marker/payload operation, detects canonical-path displacement, and
  refuses when `/proc/self/fd` custody is unavailable;

A disposable local proof may build from the already-fetched 41-file directory into a new temporary
output solely to verify the byte policy. That proves construction mechanics, not snapshot freshness
or current hosted state.

Change-impact review must additionally exercise a disposable upgrade-shaped database, partial-prefix
failure and suffix-resume model before any hosted apply is requested. It must count outputs against
inputs rather than accepting process success alone. The same disposable proof must validate the
exact CLI's application-name propagation, migration-ledger relation-lock mode, pre-migration blocking
point, single tagged-session handoff, child/session termination and guarded response-loss
reconciliation. Until that private runner and proof exist, the public probe supplies review evidence
only and no session-binding or apply-safety claim exists.

## Consequences

Accepted tradeoffs:

- the fixed baseline digest intentionally makes the builder obsolete after the hosted ledger
  advances;
- a separate live read-only gate is required because an offline tool cannot prove freshness or
  target identity;
- Git is the only subprocess so source bytes can be bound to an immutable reviewed revision;
- one generated manifest is retained so every copied byte has durable provenance;
- output must live outside the repository, so a caller cannot accidentally track target-specific
  history.

Rejected shortcuts:

- do not copy only the five new files into an empty work directory;
- do not copy the fetched work directory wholesale;
- do not reconstruct, rename or overwrite the 41 hosted-history files from repository source;
- do not use `migration repair`, `db pull` or replay an applied migration;
- do not put `supabase db push` or a project reference in the builder or runbook for this package;
- do not trust an old cached snapshot for a later production action;
- do not track the generated 46-file bundle;
- do not combine artifact construction with hosted apply, credential work, staging, activation,
  scoped admission, deployment, QA or Amazon operations.
