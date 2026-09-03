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
revision, bundle-ledger digest, manifest digest, private target fingerprint, measured native CLI
execution topology,
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

History fetch, dry run and apply receive that exact validated project reference through an explicit
`--project-ref` argument. The exact history command is `migration fetch`; the exact dry-run and
apply command is `db push`. Default, linked, local and database-URL target selection are forbidden.
The private evidence
binds `targetSelectionSha256`, computed over the ASCII bytes
`openspell.supabase-target-selection.v1\n--project-ref\n<project-ref>\n`. The raw argument record stays
private. Each command receives the fixed argument as a direct argv pair, and mutable
`supabase/.temp` linkage can neither select nor replace the authorized target.

The private supervisor owns three exact argv arrays. `<project-ref>` is the validated private value;
no caller supplies an argument, flag, path or environment entry:

```text
["/usr/local/libexec/supabase","migration","fetch","--project-ref","<project-ref>","--workdir","/operation/history","--yes","--output-format","json","--log-level","info","--agent","no"]
["/usr/local/libexec/supabase","db","push","--project-ref","<project-ref>","--skip-vault","--dry-run","--workdir","/operation/cli","--yes","--output-format","json","--log-level","info","--agent","no"]
["/usr/local/libexec/supabase","db","push","--project-ref","<project-ref>","--skip-vault","--workdir","/operation/cli","--yes","--output-format","json","--log-level","info","--agent","no"]
```

Their order is history fetch, dry run and apply. Each runs with cwd `/operation`, stdin opened from
`/dev/null`, bounded redacted stdout/stderr capture, no shell and the exact environment keys `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_ALL`, `SSL_CERT_FILE`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_DB_PASSWORD` and `PGAPPNAME`; secret values remain private. `HOME`, XDG, temp and CA paths
resolve inside the measured root/operation mounts; locale and timezone are fixed. Caller variables,
`PATH`, proxy variables, `PG*` keys other than the phase tag, loader/debug/Node variables and
`SUPABASE_CLI_BINARY_OVERRIDE` are absent. The fixed vectors exclude `--linked`, `--local`,
`--db-url`, `--include-all`, `--include-roles`, `--include-seed`, `--debug` and every extra flag.
Each phase produces a canonical private invocation leaf binding the complete argv, cwd, stdin policy,
environment-key order, hash of private environment values, stdout/stderr policy, runtime-image digest,
phase tag digest and preauthorized child-cgroup naming/resource policy. The envelope carries the
SHA-256 of each leaf; disposable
exact-CLI proof must validate these vectors and their noninteractive output before production use.

The invocation leaf has this exact key order:

```json
{
  "schemaVersion": "openspell.supabase-invocation.v1",
  "phase": "history_fetch",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "nativeRuntimeIdentitySha256": "...",
  "runtimeImageSha256": "...",
  "executablePath": "/usr/local/libexec/supabase",
  "argvSha256": "...",
  "cwd": "/operation",
  "stdinPolicy": "dev_null",
  "environmentKeys": [
    "HOME",
    "LANG",
    "LC_ALL",
    "PGAPPNAME",
    "SSL_CERT_FILE",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "TMPDIR",
    "TZ",
    "XDG_CONFIG_HOME"
  ],
  "environmentValuesSha256": "...",
  "stdoutPolicy": "bounded_redacted",
  "stderrPolicy": "bounded_redacted",
  "maxOutputBytesPerStream": 1048576,
  "phaseSessionTagSha256": "...",
  "childCgroupPolicySha256": "..."
}
```

`phase` is exactly `history_fetch`, `dry_run` or `apply`; `environmentKeys` is the exact sorted list
above. `argvSha256` is SHA-256 over
`openspell.supabase-argv.v1\n<canonical-json-array>\n`. `environmentValuesSha256` is SHA-256 over
`openspell.supabase-environment.v1\n<canonical-json-array>\n`, where the array contains objects with
exact key order `key`, `value` in the same order as `environmentKeys`. Canonical JSON uses the
manifest's UTF-8, escaping and no-extra-key rules, so arbitrary private values cannot create delimiter
collisions. The private leaf carries hashes, while the supervisor retains the raw argv/environment
evidence under mode-`0700` custody for execution and attended audit.

`childCgroupPolicySha256` hashes a canonical pre-spawn policy binding the operation-derived cgroup
name, parent cgroup identity, root-launcher identity, process and memory ceilings, descendant-only
membership rule and kill/empty proof requirements. It does not claim a future cgroup inode, pid or
membership observation. The root launcher's signed runtime attestation records those actual values
after creation and binds them back to this policy digest.

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
- Supabase CLI `2.116.0` plus both official native binaries' SHA-256 values, formats, immutable
  release provenance, runtime-image/dependency digest and a phase-specific exec-topology policy, with
  the same supervisor-private measured pair used for history fetch, dry run and apply and no host
  launcher, shell or path lookup;
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
out an actor that ignores both the private supervisor's durable target quarantine and the shared
advisory key; that is an operational exclusivity precondition, not a fact this public SQL can prove.

The future guarded runner closes those gaps with a private database guard session. While holding its
separate durable target quarantine, it opens one target-bound connection, records its backend id and
backend start, and uses a bounded non-waiting attempt to acquire the session-level advisory lock on
the exact `wizard-ads:schema-ddl:v1` key. Failure to acquire refuses. The runner keeps that connection
and lock under custody for preflight, then runs the probe, selected prefix script and second probe on
that same connection. The prefix script's rollback does not release the session-level lock. The
public probe excludes only its own guard backend, so any other granted or waiting holder still fails.
Both probe results must be byte-identical, including prefix selection and all activity counts, and
the prefix evidence must agree with the authorized leaves. Connection loss, lock loss, a changed
backend identity or any observation mismatch makes the outcome ambiguous and blocks action. This
guarded protocol is a contract for a later private runner; neither the public SQL nor WP-197's
offline tool implements it.

The pending migrations themselves acquire the same advisory key transactionally before DDL, so the
runner must not retain its session-level guard throughout apply. Instead it performs a two-stage
handoff. First, immediately before spawn, the guard session begins a short transaction and acquires
`ACCESS EXCLUSIVE` on the already-existing `supabase_migrations.schema_migrations` relation with a
bounded non-waiting attempt. Failure refuses. The future runner then spawns the exact measured native
CLI child with the private operation's apply-phase application name. Before releasing the relation
barrier, it must observe exactly one matching target backend whose ungranted relation lock is blocked
solely by the recorded guard backend. Exact CLI `2.116.0` disposable proof must establish the
requested lock mode as exactly `AccessShareLock` and prove the reviewed invocation reaches this
ledger read before any statement capable of applying a migration.

The runner binds that backend id and backend start to the already-owned child process and private
target. Runtime handoff requires exactly one backend with the exact apply tag and no additional
matching session or blocker; the separate exact-binary proof must establish that the CLI never opens
an untagged target connection. If the exact tag is absent or duplicated, or the backend is not
waiting on that relation or has any other blocker, the runner terminates the still-blocked child and
proves process termination, an empty operation cgroup and session termination before ending the
barrier transaction. After a valid first handoff it durably records the binding and commits only the
short relation-barrier transaction while retaining the advisory guard. The same bound CLI backend
may then read the ledger and must become the sole waiter for the exact advisory key, blocked only by
the guard, when the first pending migration requests its transaction-level lock. The runner durably records
that second binding, proves there is no other holder or waiter, persists it and releases the session-
level guard. The database-observed wait age plus handoff persistence and confirmed unlock must total
at most one second, safely below the migration's five-second `lock_timeout`. That release is the
first point at which the child may pass the pending migration's pre-DDL guard. The
durable target quarantine and enqueue freeze remain held through child termination, reconciliation and postflight;
the database advisory guard does not. Loss of the guard connection after the relation barrier opens,
failure to observe the second handoff or uncertainty about the child/session state makes the outcome
ambiguous, never proof that nothing ran.

Separate history-fetch, dry-run and apply session tags are derived inside the guarded operation from
its independently generated operation id, nonce and fixed phase name. Each tag's exact form is
`os-wp197-cli-` followed by the first 48 lowercase hexadecimal
characters of SHA-256 over
`openspell.hosted-migration-session.v1\n<operation-id>\n<authorization-nonce>\n<phase>\n`, where
`phase` is exactly `history_fetch`, `dry_run` or `apply`. The complete name is
61 ASCII bytes, below PostgreSQL's application-name limit. The raw tag stays in guarded memory and
private evidence. Each phase digest is SHA-256 over its complete 61 ASCII tag bytes, and the private
operation envelope carries only those digests. The exact CLI `2.116.0` disposable proof must show
that the reviewed invocation channel applies the right phase tag to every database connection and
that each completed phase leaves zero matching sessions; if it cannot, this handoff contract is
unavailable and no production apply may use it.

If an apply response is lost, only the read-only reconciler may run. The private operation ledger
must first prove the exact child process terminal, its operation cgroup empty and zero sessions with
the exact apply tag. If the host or supervisor outcome is uncertain, recovery stays blocked until
attended process inspection proves that child cannot still run. Only after terminality may the
runner open a new target-bound guard session and reacquire the advisory lock non-waitingly. It then
runs the guarded probe/prefix/probe sandwich. Only this combined private evidence may identify one
exact contiguous prefix from 41 through 46. The public probe alone makes no matching-session claim.
Recovery is forward-only. Any remaining suffix requires a new dry run, operation id, nonce, all
three phase tags, evidence and exact operator authorization. Blind retry, migration repair, reverse
SQL and replay of an already-applied file are forbidden.

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

Before native-runtime preparation or any target-connected phase, the private supervisor atomically
claims a durable per-target quarantine in its operation journal. Its canonical private leaf is:

```json
{
  "schemaVersion": "openspell.hosted-migration-target-quarantine.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "generation": 1,
  "state": "held",
  "supervisorRevision": "...",
  "ownerBootIdSha256": "...",
  "acquiredAt": "..."
}
```

`generation` is a positive integer advanced by a transactional compare-and-set for that target.
The supervisor revision is lowercase 40-hex; the boot-id digest is lowercase 64-hex; and
`acquiredAt` is UTC RFC 3339 with milliseconds and `Z`. An existing nonterminal or ambiguous target
record refuses a new operation. The leaf is synced before native-runtime preparation and remains
`held` until exact terminal reconciliation and postflight; process or service exit cannot release it.

One root-owned authoritative journal and one host-global singleton supervisor lock own all target
generations. Missing, duplicated or corrupt authority refuses service startup. A valid nonterminal or
ambiguous record starts the service in recovery-only mode: it permits status and read-only reconcile,
but no prepare, latch consumption, child spawn or new generation until exact terminal classification
closes the record. The dedicated supervisor is the only service authority that receives the target-
scoped migration credentials and may pass one phase-scoped environment to its bound CLI child;
installation evidence must prove no second credentialed runner authority.
Because a manual CLI or another host cannot honor this local quarantine, a separate attended
exclusive-operation window must explicitly exclude those actors through postflight. The quarantine
is never described as global proof without that external exclusivity evidence.

That external window is a separate, root-signed authority rather than an operator note. Its
canonical private leaf has this exact key order:

```json
{
  "schemaVersion": "openspell.hosted-migration-external-window.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "generation": 1,
  "state": "held",
  "excludedActorClasses": [
    "agent_brokers",
    "manual_cli",
    "other_hosts",
    "scheduled_jobs"
  ],
  "actorRosterSha256": "...",
  "credentialInventorySha256": "...",
  "issuerRevision": "...",
  "issuerPublicKeySha256": "...",
  "acquiredAt": "...",
  "expiresAt": "...",
  "detachedSignatureSha256": "..."
}
```

The array is exact and sorted as shown. The root authority advances `generation` with a durable
compare-and-set and signs the canonical fields from `schemaVersion` through `expiresAt` using Ed25519
with a raw 32-byte public key and raw 64-byte signature. The signed bytes are exactly
`openspell.hosted-migration-external-window-signature.v1\n<canonical-unsigned-leaf>\n`; the final
field is SHA-256 of the raw signature retained in the root authority's private signature store under
that digest. Root-owned policy pins
`issuerPublicKeySha256`, and verification compares the pin before checking the signature. The signing
key is unavailable to the supervisor. The authority refuses an unknown roster member, an
unacknowledged actor, or any broad credential that could bypass
the window. The target-scoped migration credential is counted in the inventory as held exclusively
by this operation. The leaf remains `held` and unexpired through terminal classification and
postflight. Its complete digest and generation are displayed by the attended latch, bound into the
operation envelope, revalidated after root approval consumption immediately before child creation, and
compared again before postflight can release either quarantine.

The executable source has an independent trust root before it enters supervisor custody. The private
root helper pins these public release constants in reviewed, root-owned policy:

- repository `supabase/cli`, release tag `v2.116.0`;
- asset `supabase_2.116.0_linux_amd64.tar.gz`, SHA-256
  `5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158`;
- release asset `checksums.txt`, SHA-256
  `54f8d735be5b852a5f10afb116eeca46336f12aa4b398ee1fe26e5efd8ab35aa`, whose exact entry for that
  archive equals the pinned archive digest; and
- exact two-entry archive inventory: regular-file front controller `supabase`, 96,900,296 bytes,
  SHA-256 `3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4`, and regular-file Go
  delegate `supabase-go`, 43,892,898 bytes, SHA-256
  `1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1`.

An attended root acquisition downloads both immutable release assets directly into a newly created
root-owned directory, verifies the pinned checksums-asset digest, its exact archive line, the archive
digest, a safe exact two-entry one-level regular-file extraction and both expected binary digests,
and then installs
from the retained root-owned descriptor. Every source path component must be root-owned and
non-writable by group or other. A Homebrew or package-manager cache, user download, agent-produced
archive, copied executable, or any source with an agent-writable ancestor is rejected even when its
self-hash matches. The acquisition helper has no target credentials; it completes before the
supervisor can prepare an operation.

The supervisor also records the exact official two-binary CLI topology and immutable runtime it will
execute in
this canonical private identity leaf:

```json
{
  "schemaVersion": "openspell.supabase-native-runtime.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "cliVersion": "2.116.0",
  "nativeFormat": "ELF64",
  "nativeArchitecture": "x86_64",
  "frontControllerRelativePath": "usr/local/libexec/supabase",
  "frontControllerDevice": 1,
  "frontControllerInode": 2,
  "frontControllerBytes": 96900296,
  "frontControllerSha256": "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4",
  "delegateRelativePath": "usr/local/libexec/supabase-go",
  "delegateDevice": 1,
  "delegateInode": 3,
  "delegateBytes": 43892898,
  "delegateSha256": "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1",
  "delegateLinkage": "static",
  "frontControllerInterpreterRelativePath": "lib64/ld-linux-x86-64.so.2",
  "frontControllerInterpreterBytes": 254864,
  "frontControllerInterpreterSha256": "...",
  "frontControllerDependencies": [
    {
      "soname": "libc.so.6",
      "relativePath": "usr/lib/x86_64-linux-gnu/libc.so.6",
      "bytes": 2186512,
      "sha256": "..."
    },
    {
      "soname": "libdl.so.2",
      "relativePath": "usr/lib/x86_64-linux-gnu/libdl.so.2",
      "bytes": 14408,
      "sha256": "..."
    },
    {
      "soname": "libm.so.6",
      "relativePath": "usr/lib/x86_64-linux-gnu/libm.so.6",
      "bytes": 1198376,
      "sha256": "..."
    },
    {
      "soname": "libpthread.so.0",
      "relativePath": "usr/lib/x86_64-linux-gnu/libpthread.so.0",
      "bytes": 14408,
      "sha256": "..."
    }
  ],
  "runtimeImageDevice": 3,
  "runtimeImageInode": 4,
  "runtimeImageBytes": 150000000,
  "runtimeImageSha256": "...",
  "officialSourceEvidenceSha256": "...",
  "releaseProvenanceSha256": "...",
  "childSandboxPolicySha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "measuredAt": "..."
}
```

Each `frontControllerDependencies` entry has exact key order `soname`, `relativePath`, `bytes`, `sha256`; the
array is sorted by unsigned UTF-8 `soname`, then `relativePath`, with no duplicates. The byte counts
are positive integers and every digest is lowercase 64-hex. The exact 2.116.0 Linux front controller
requires the four shown nonempty dependency entries; its separately bound `PT_INTERP` loader is
deliberately excluded from that array. The co-located delegate is the exact statically linked ELF
shown above. Omission, substitution or an extra resolved dependency refuses.

`runtimeImageSha256` hashes this separate canonical private manifest:

```json
{
  "schemaVersion": "openspell.supabase-runtime-image.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "rootDevice": 3,
  "rootInode": 4,
  "rootMode": "0555",
  "rootUid": 0,
  "rootGid": 0,
  "mountFlags": ["nodev", "nosuid", "ro"],
  "directories": [
    {
      "relativePath": "usr/local/libexec",
      "mode": "0555",
      "uid": 0,
      "gid": 0
    }
  ],
  "files": [
    {
      "relativePath": "usr/local/libexec/supabase",
      "mode": "0555",
      "uid": 0,
      "gid": 0,
      "linkCount": 1,
      "bytes": 96900296,
      "sha256": "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4"
    },
    {
      "relativePath": "usr/local/libexec/supabase-go",
      "mode": "0555",
      "uid": 0,
      "gid": 0,
      "linkCount": 1,
      "bytes": 43892898,
      "sha256": "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1"
    }
  ]
}
```

Each directory entry has exact key order `relativePath`, `mode`, `uid`, `gid`; each file entry has
exact key order `relativePath`, `mode`, `uid`, `gid`, `linkCount`, `bytes`, `sha256`. Both arrays are
sorted by unsigned UTF-8 relative path and contain every object under the root with no symlink,
device, socket, FIFO, hard link or extra path. Directory modes are `0555`; regular executable modes
are `0555`; data-file modes are `0444`; owners are root; and every file has link count one. The file
array includes both official binaries, the front controller interpreter and complete dependencies,
CA trust, resolver inputs and fixed
locale/timezone inputs. The manifest byte total equals `runtimeImageBytes`.
The entries shown above establish field order; a valid manifest expands both arrays to the complete
tree and is rejected if it contains only the representative entries.

The minimal root launcher mounts that root-owned, non-writable filesystem image as `/` in a private
child mount namespace, bind-mounts only the operation work directory at fixed `/operation`, and uses
a dedicated CLI-child cgroup containing the direct child and descendants but never the supervisor or
database-guard session. The first child pivots into the measured root and executes the official
`/usr/local/libexec/supabase` front controller. The image also contains its exact co-located
`supabase-go` delegate because the official front controller is a shim that may forward a command;
`SUPABASE_GO_BINARY` remains absent, so no environment-selected delegate is possible.

`phaseExecTopologyPolicySha256` binds a canonical policy for all three fixed invocation vectors. A
disposable target must establish separately for history fetch, dry run and apply whether the front
controller performs no secondary exec or creates exactly the measured co-located delegate, including
the exact ordered parent/child relation and argv digest. The policy contains no optional branch: the
observed result for each phase becomes its only accepted graph. Production use is a no-go until that
proof exists.

History fetch and dry run occur before the attended apply envelope exists, so they never depend on an
apply execution ticket. The root authority may issue this exact canonical single-use preparation
ticket without operator write approval:

```json
{
  "schemaVersion": "openspell.hosted-migration-preparation-ticket.v1",
  "ticketNonce": "...",
  "operationId": "...",
  "authorizationNonce": "...",
  "phase": "history_fetch",
  "writeCapability": false,
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "officialSourceEvidenceSha256": "...",
  "nativeRuntimeIdentitySha256": "...",
  "childSandboxPolicySha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "phaseInvocationEvidenceSha256": "...",
  "issuedAt": "...",
  "expiresAt": "...",
  "state": "prepared",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

`phase` is exactly `history_fetch` or `dry_run`; the latter ticket's invocation must contain
`--dry-run`, while neither ticket can name the apply invocation or omit its phase's non-write flags.
The root authority generates the ticket nonce as a unique 256-bit lowercase-hex value and signs
canonical fields through `issuerPublicKeySha256` with the pinned Ed25519 key over
`openspell.hosted-migration-preparation-ticket-signature.v1\n<canonical-unsigned-ticket>\n`; the
final field hashes the root-retained raw signature. The root launcher verifies the signature, exact
phase argv/runtime/topology/sandbox/cgroup tuple and `writeCapability:false`, then atomically fsyncs a
separate phase-journal transition from `prepared` to `executing` before creating resources and to
`terminal` only after the signed terminal graph closes. Tickets are phase-bound, single-use and
non-convertible; presenting one for apply, a different phase or a write-capable vector refuses.

A conclusively unexecuted preparation ticket closes only through this separate canonical result:

```json
{
  "schemaVersion": "openspell.hosted-migration-preparation-no-execution-result.v1",
  "preparationTicketSha256": "...",
  "ticketNonce": "...",
  "operationId": "...",
  "authorizationNonce": "...",
  "phase": "history_fetch",
  "writeCapability": false,
  "targetFingerprint": "...",
  "rootPhaseJournalGeneration": 2,
  "reasonCode": "preparation_ticket_expired",
  "priorState": "prepared",
  "terminalState": "terminal_no_spawn",
  "executingTransitionCount": 0,
  "namespaceCreationCount": 0,
  "cgroupCreationCount": 0,
  "childCreationCount": 0,
  "pidfdCreationCount": 0,
  "phaseSessionCount": 0,
  "zeroPhaseSessionEvidenceSha256": "...",
  "targetQuarantineEvidenceSha256": "...",
  "observedAt": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

The phase matches the preparation ticket. Only `preparation_ticket_expired`,
`preparation_invariant_failed` and `preparation_launcher_rejected_before_execution` are valid reason
codes, and every count is exactly zero. The authority signs canonical fields through
`issuerPublicKeySha256` with the pinned Ed25519 key over exactly
`openspell.hosted-migration-preparation-no-execution-result-signature.v1\n<canonical-unsigned-result>\n`;
the final field hashes the root-retained raw signature. One root-journal transaction must prove by
compare-and-set that `prepared` never entered `executing`, verify the root-launcher zero-resource
audit plus fresh zero exact-phase-tag sessions, advance the generation, persist the complete result
and signature, change the phase state to `terminal_no_spawn`, and fsync atomically. An uncertain fact
or an `executing` phase remains recovery-only. Operation abandonment and a new target generation are
allowed only after every issued preparation-phase journal is conclusively `terminal` or
`terminal_no_spawn`; a dry-run ticket cannot be issued unless history fetch closed successfully.

The root launcher retains `PTRACE_O_TRACEFORK`, `PTRACE_O_TRACEVFORK`, `PTRACE_O_TRACECLONE` and
`PTRACE_O_TRACEEXEC` custody over the entire cgroup. At every exec stop, before application entry or
network use, it verifies the namespace root device/inode, `/proc/<pid>/exe`, every file-backed
`/proc/<pid>/maps` entry and the ordered exec graph against the retained runtime manifest and
topology policy. It then establishes `PR_SET_NO_NEW_PRIVS`, empty capability sets and core limit zero,
injects `PR_SET_DUMPABLE(0)` after the ordinary ELF exec reset, verifies `PR_GET_DUMPABLE` returns
zero, and installs a seccomp rule that rejects a later nonzero dumpability change. It repeats those
checks for the measured delegate when the bound phase policy requires one. An unexpected fork, exec,
host mapping, writable/root-identity mismatch or failed post-exec protection terminates the cgroup
before network release. The unprivileged supervisor does not ptrace or read another uid's `/proc`.

The launcher appends this exact canonical post-spawn leaf for each accepted exec:

```json
{
  "schemaVersion": "openspell.hosted-migration-runtime-attestation.v1",
  "phase": "apply",
  "operationId": "...",
  "authorizationNonce": "...",
  "phaseAuthorizationKind": "apply_execution_ticket",
  "phaseAuthorizationSha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "childCgroupEvidenceSha256": "...",
  "execOrdinal": 1,
  "processPid": 456,
  "processStart": "...",
  "parentPid": 455,
  "parentStart": "...",
  "executableRelativePath": "usr/local/libexec/supabase",
  "executableSha256": "...",
  "namespaceRootDevice": 3,
  "namespaceRootInode": 4,
  "mapsManifestSha256": "...",
  "runtimeUid": 200,
  "runtimeGid": 200,
  "noNewPrivileges": true,
  "dumpable": false,
  "coreLimitBytes": 0,
  "effectiveCapabilities": [],
  "permittedCapabilities": [],
  "inheritableCapabilities": [],
  "ambientCapabilities": [],
  "procPolicySha256": "...",
  "egressPolicySha256": "...",
  "observedAt": "...",
  "rootLauncherIdentitySha256": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

`phase` is one of the three fixed phase names, `phaseAuthorizationKind` is exactly
`preparation_ticket` for history fetch and dry run or `apply_execution_ticket` for apply, and its
digest identifies that phase's complete signed ticket. `execOrdinal` starts at one and increases by one, and
the executable path/hash must be the measured front controller or delegate required at that ordinal.
The launcher signs canonical fields through `issuerPublicKeySha256` using the pinned raw 32-byte
Ed25519 public key and raw 64-byte signature over exactly
`openspell.hosted-migration-runtime-attestation-signature.v1\n<canonical-unsigned-leaf>\n`; the final
field hashes the raw signature retained in private root evidence. This actual evidence is post-spawn
audit and is never predicted inside the pre-spawn envelope.

The launcher folds each complete signed leaf, including its `detachedSignatureSha256` field, into a
chain. The genesis previous value is exactly 32 zero bytes. Every later previous value and leaf digest
is the raw 32-byte SHA-256 result, never hexadecimal text. Stored chain fields encode the resulting
raw value as exactly 64 lowercase hexadecimal characters. For ordinal `n`, the exact preimage is
`ASCII("openspell.hosted-migration-runtime-attestation-chain.v1\0") || UINT32_BE(n) ||
previousRaw32 || SHA256(canonical-complete-signed-leaf)Raw32`. Before network release and database-session binding, the observed
chain must equal the phase policy's complete database-owning exec prefix: one front-controller leaf
when the proved phase has no delegate, or the ordered front-controller then delegate leaves when it
does. The session-binding record carries that chain-prefix digest and observed exec count. The
terminal graph must extend that exact prefix without substitution and is required for terminal
classification and postflight. Its exact canonical record is:

```json
{
  "schemaVersion": "openspell.hosted-migration-terminal-exec-graph.v1",
  "phase": "apply",
  "operationId": "...",
  "authorizationNonce": "...",
  "phaseAuthorizationKind": "apply_execution_ticket",
  "phaseAuthorizationSha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "boundChainPrefixSha256": "...",
  "boundObservedExecCount": 1,
  "terminalChainSha256": "...",
  "terminalObservedExecCount": 1,
  "terminalGraphState": "closed",
  "childCgroupEmpty": true,
  "taggedSessionCount": 0,
  "observedAt": "...",
  "rootLauncherIdentitySha256": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

Both counts are positive integers fixed by the proved phase policy; the terminal count is not smaller
than the bound count. Recomputing the chain from genesis through `boundObservedExecCount` must equal
`boundChainPrefixSha256`; continuing through the complete policy graph must equal
`terminalChainSha256` and `terminalObservedExecCount`. The final graph uses Ed25519 and the exact
domain `openspell.hosted-migration-terminal-exec-graph-signature.v1\n<canonical-unsigned-graph>\n`
with the same key, signature custody and final signature-digest rule as each exec leaf.

`officialSourceEvidenceSha256` hashes this canonical private leaf:

```json
{
  "schemaVersion": "openspell.supabase-official-source.v1",
  "repository": "supabase/cli",
  "releaseTag": "v2.116.0",
  "checksumsAssetName": "checksums.txt",
  "checksumsAssetBytes": 1414,
  "checksumsAssetSha256": "54f8d735be5b852a5f10afb116eeca46336f12aa4b398ee1fe26e5efd8ab35aa",
  "archiveAssetName": "supabase_2.116.0_linux_amd64.tar.gz",
  "archiveBytes": 56699663,
  "archiveSha256": "5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158",
  "archiveEntries": ["supabase", "supabase-go"],
  "frontControllerEntry": "supabase",
  "frontControllerBytes": 96900296,
  "frontControllerSha256": "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4",
  "delegateEntry": "supabase-go",
  "delegateBytes": 43892898,
  "delegateSha256": "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1",
  "sourceRootDevice": 1,
  "sourceRootInode": 2,
  "sourceRootMode": "0700",
  "sourceRootUid": 0,
  "sourceRootGid": 0,
  "ancestorWalkSha256": "...",
  "acquiredAt": "..."
}
```

The device/inode values shown are examples measured during root acquisition; the fixed release
facts, sorted two-entry archive inventory and digests must equal the values shown. The ancestor digest binds the ordered device, inode,
mode, uid and gid tuple for every opened path component from the filesystem root to the retained
source descriptor. `releaseProvenanceSha256` is SHA-256 over the domain-separated canonical JSON object whose
ordered fields are `schemaVersion`, `officialSourceEvidenceSha256`, `frontControllerSha256`,
`delegateSha256`, `phaseExecTopologyPolicySha256` and
`runtimeImageSha256`; it is not a self-asserted package label. `measuredAt` is UTC RFC 3339 with
milliseconds and `Z`. Before history fetch, dry run and apply, the supervisor reopens the retained
source and root image, hashes and compares every bound object and field, repeats the root ownership
and ancestor checks, and refuses any source, interpreter, dependency, format, permission, ownership,
provenance, namespace or image drift.

`childSandboxPolicySha256` hashes this canonical private policy leaf:

```json
{
  "schemaVersion": "openspell.supabase-child-sandbox-policy.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "runtimeUid": 200,
  "runtimeGid": 200,
  "noNewPrivileges": true,
  "dumpableAfterEachExec": false,
  "coreLimitBytes": 0,
  "effectiveCapabilities": [],
  "permittedCapabilities": [],
  "inheritableCapabilities": [],
  "ambientCapabilities": [],
  "rootLauncherIdentitySha256": "...",
  "runtimeAttestationPublicKeySha256": "...",
  "execTracePolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "procPolicySha256": "...",
  "egressPolicySha256": "...",
  "credentialScopeEvidenceSha256": "..."
}
```

The numeric uid/gid shown are examples selected at installation and bound exactly in real evidence;
they must name a dedicated non-login CLI identity with no agent or supervisor group membership. This
leaf authorizes policy and the exact root-launcher/key identity, not a future pid, cgroup inode,
`/proc` observation or runtime outcome. The root launcher creates the mount/network namespace and
child-only cgroup but receives no Supabase credential input and exposes no general execution
interface. It changes to the bound CLI uid/gid, clears every capability set, establishes the fixed
post-exec tracing/protection sequence described above, disables core dumps, and installs the fixed
syscall and network policy. Private pid/proc namespaces and process-inspection policy prevent the
coding-agent and unrelated service identities from reading the child environment. Egress is limited
to the bound provider control endpoint, target database endpoint and guarded resolver required by the
proven phase; an extra destination refuses. The credential evidence
must prove project/target scope and phase need. A personal or organization-wide access token, broad
service token, `service_role`, or any credential usable against another project is forbidden. If the
exact 2.116.0 CLI cannot complete disposable proof with a target-scoped credential, this runner is a
production no-go and the architecture must change before apply.

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
  "targetQuarantineEvidenceSha256": "...",
  "externalExclusiveWindowGeneration": 1,
  "externalExclusiveWindowEvidenceSha256": "...",
  "sourceRevision": "...",
  "manifestSha256": "...",
  "bundleLedgerSha256": "...",
  "cliVersion": "2.116.0",
  "cliFrontControllerSha256": "...",
  "cliDelegateSha256": "...",
  "cliNativeRuntimeIdentitySha256": "...",
  "cliRuntimeImageSha256": "...",
  "cliReleaseProvenanceSha256": "...",
  "cliChildSandboxPolicySha256": "...",
  "cliPhaseExecTopologyPolicySha256": "...",
  "historyFetchInvocationEvidenceSha256": "...",
  "dryRunInvocationEvidenceSha256": "...",
  "applyInvocationEvidenceSha256": "...",
  "historyFetchTerminalExecGraphEvidenceSha256": "...",
  "dryRunTerminalExecGraphEvidenceSha256": "...",
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
  "historyFetchSessionTagSha256": "...",
  "dryRunSessionTagSha256": "...",
  "applySessionTagSha256": "...",
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

The history-fetch and dry-run terminal-graph digests must identify complete root-signed graph leaves
whose `phaseAuthorizationKind` is `preparation_ticket`, whose authorization digest names the matching
single-use non-write ticket, and whose chain/count exactly closes that phase policy. Both phase
journals must be terminal with empty cgroups and zero matching sessions before the envelope can be
created. An apply runtime attestation is necessarily post-authorization and is not predicted in the
envelope.

The applying supervisor is a dedicated deployment-private service with its own identity and mode-
`0700` state, separate from the general agent-accessible transport. Any agent-accessible endpoint is
limited to `prepare`, `status` and read-only `reconcile`; it exposes no apply, approve, arbitrary
command, target, credential, path, SQL, flag or environment input. Preparing or discussing an
operation in chat never authorizes it.

Apply requires a distinct root/operator-only latch inaccessible to the coding-agent UID, the
unprivileged supervisor and every agent-accessible socket. A root-owned helper performs fresh
attended OS authentication and displays the sanitized exact envelope facts, including official
archive/payload provenance, child sandbox, external-window generation/digest, target quarantine and
expiry. It accepts only the complete envelope digest for the already prepared operation and creates
this canonical private grant in exact key order:

```json
{
  "schemaVersion": "openspell.hosted-migration-approval-grant.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "envelopeSha256": "...",
  "externalExclusiveWindowGeneration": 1,
  "externalExclusiveWindowEvidenceSha256": "...",
  "officialSourceEvidenceSha256": "...",
  "nativeRuntimeIdentitySha256": "...",
  "childSandboxPolicySha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "applyInvocationEvidenceSha256": "...",
  "issuedAt": "...",
  "expiresAt": "...",
  "authenticatedOperatorIdentitySha256": "...",
  "osAuthenticationSessionSha256": "...",
  "authenticatedAt": "...",
  "state": "approved",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

The root approval authority owns its journal and signing key; neither is readable or writable by the
supervisor or CLI child. It signs the canonical fields from `schemaVersion` through
`issuerPublicKeySha256` using Ed25519. The signed bytes are exactly
`openspell.hosted-migration-approval-grant-signature.v1\n<canonical-unsigned-grant>\n`; the final
field hashes the retained raw 64-byte signature, and root-owned policy pins the raw 32-byte public-
key digest. Peer credentials and the OS authentication audit must agree; authentication is at most
five minutes old and cannot outlive envelope expiry.

At execution time the same root authority, reached only through a fixed private request from the
dedicated supervisor identity, verifies the grant signature and complete operation tuple, then
atomically changes the root journal from `approved` to `consumed` and fsyncs before returning this
canonical signed one-use ticket:

```json
{
  "schemaVersion": "openspell.hosted-migration-execution-ticket.v1",
  "approvalGrantSha256": "...",
  "approvalGrantSignatureSha256": "...",
  "ticketNonce": "...",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "envelopeSha256": "...",
  "externalExclusiveWindowGeneration": 1,
  "externalExclusiveWindowEvidenceSha256": "...",
  "officialSourceEvidenceSha256": "...",
  "nativeRuntimeIdentitySha256": "...",
  "childSandboxPolicySha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "applyInvocationEvidenceSha256": "...",
  "consumedAt": "...",
  "expiresAt": "...",
  "state": "consumed",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

The authority generates `ticketNonce` as a new 256-bit random lowercase-hex value with a uniqueness
constraint. It signs the canonical fields through `issuerPublicKeySha256` over exactly
`openspell.hosted-migration-execution-ticket-signature.v1\n<canonical-unsigned-ticket>\n`; the final
field again hashes the retained raw signature. Every repeated tuple field must equal the grant and
envelope. The minimal root launcher, not the supervisor, verifies both signatures, public-key pin,
grant and ticket digests, expiry and the exact operation/envelope/nonce/target/window/argv/runtime/
sandbox/topology/cgroup-policy tuple. It then atomically changes the authoritative root journal from
`consumed` to `executing` and fsyncs before namespace or cgroup creation and before fork or exec. Reuse, a missing
state transition or any mismatch refuses. The supervisor may verify the ticket and append a mirrored
execution receipt, but that receipt is never the spawn gate and cannot alter the root journal.

The root launcher records the conclusive pid/start identity before returning the pidfd, then changes
the root journal from `executing` to `terminal` only after child, cgroup and tagged-session evidence
closes. There is one separate safe no-execution close path. While an atomic compare-and-set still
proves the root journal is `consumed` and never entered `executing`, the root authority may verify its
launcher audit has zero namespace, cgroup, child and pidfd creation for that ticket and require fresh
read-only evidence of zero apply-tag sessions. The exact canonical result is:

```json
{
  "schemaVersion": "openspell.hosted-migration-no-execution-result.v1",
  "approvalGrantSha256": "...",
  "executionTicketSha256": "...",
  "ticketNonce": "...",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "rootJournalGeneration": 2,
  "reasonCode": "pre_spawn_invariant_failed",
  "priorState": "consumed",
  "terminalState": "terminal_no_spawn",
  "executingTransitionCount": 0,
  "namespaceCreationCount": 0,
  "cgroupCreationCount": 0,
  "childCreationCount": 0,
  "pidfdCreationCount": 0,
  "applySessionCount": 0,
  "zeroApplySessionEvidenceSha256": "...",
  "targetQuarantineEvidenceSha256": "...",
  "externalExclusiveWindowGeneration": 1,
  "externalExclusiveWindowEvidenceSha256": "...",
  "observedAt": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

Every count is exactly the shown nonnegative integer and `rootJournalGeneration` is the positive CAS
generation created by this transition. Only reason codes `pre_spawn_invariant_failed`,
`ticket_expired` and `launcher_rejected_before_execution` are valid. The authority signs canonical
fields from `schemaVersion` through `issuerPublicKeySha256` with the same pinned raw 32-byte Ed25519
public key and raw 64-byte signature. Signed bytes are exactly
`openspell.hosted-migration-no-execution-result-signature.v1\n<canonical-unsigned-result>\n`; the
final field hashes the raw signature retained in root custody. One root-journal transaction verifies
the zero facts, changes `consumed` to `terminal_no_spawn`, persists this complete result/signature and
fsyncs atomically. Its digest is appended to the supervisor's non-authorizing journal. After that
conclusive result, the quarantine/window may close and only a new operation, generation, envelope,
grant and ticket may proceed. Any failed compare-and-set, incomplete launcher audit or uncertain
resource/session fact remains quarantined in recovery-only mode. A `consumed` or `executing` ticket
without one of these conclusive terminal paths remains quarantined; no component may reissue, reset
or replay it. A broker call, agent peer identity, forged grant, forged ticket, second consumption,
different tuple or missing durable audit refuses.

The guarded runner creates all three phase session tags before history fetch and binds their SHA-256
values into the envelope. It passes the applicable raw tag only through the reviewed `PGAPPNAME`
environment entry to the exact private CLI child. The child environment is an exact allowlist;
callers cannot add, replace or read a tag. Disposable proof against the exact native CLI binary must
demonstrate that every connection it opens carries the complete, untruncated tag for its phase and
that the phase ends with zero matching sessions. Merely setting the environment entry without
observing the database session is not proof.

`schemaDdlGuardEvidenceSha256` hashes this canonical private leaf, with the same JSON serialization
rules and key order used by the envelope:

```json
{
  "schemaVersion": "openspell.hosted-schema-ddl-guard.v1",
  "phase": "pre_apply",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "applySessionTagSha256": "...",
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

Before history fetch, the guarded operation resolves the independently verified official root-owned
source to its exact front-controller/delegate pair rather than any host command path, package-manager
copy or launcher. It rejects symlinks, environment-selected overrides and any host wrapper that can
resolve a different child. It constructs the canonical
private native-runtime image above, retains the image under exclusive mode-`0700` supervisor custody
and mounts it read-only as the child namespace root for every phase. Every phase directly executes
the fixed front-controller path inside that measured root and permits only the topology-bound delegate,
never host `PATH`, a launcher or a shell. The image
and its mount identity stay under exclusive guarded custody through apply.

The `pre_apply` observation and external-window evidence must be less than 60 seconds old when
attended authorization is issued.
The pre-apply target leaf binds the operation id and nonce, `pre_apply` phase, observation time,
target fingerprint, observed prefix count and ledger digest, `prefixEvidenceSha256`, and
`stateComparisonEvidenceSha256`. The pre-apply freeze leaf binds the same operation identity and
phase, observation time, target fingerprint, reviewed freeze mechanism and generation, held state,
producer-admission state, active recommendation-job count and queue fingerprint. The root helper
must independently verify the external-window signature, held generation, actor roster, credential
inventory and expiry before displaying and signing the grant. All three observations must be less
than 60 seconds old at authorization.

After the root authority consumes the grant and before spawning the CLI, the guarded writer performs
the last pre-spawn checks in this order: verify the same target-bound database guard connection,
backend
identity and session-level lock; reopen the retained private runtime without following links; and
remeasure every canonical native-runtime identity field, including both binaries, interpreter,
dependency set, image digest, format, version, official source provenance, topology policy and child-
sandbox policy. It then derives the target fingerprint and
target-selection digest from the same canonical project-ref preimage; reruns the guarded
probe/prefix/probe sandwich on the guard connection; compares the four named fingerprints to
preflight; rechecks the held target quarantine, external-window generation/signature/roster/
credential inventory and freeze; and runs `verify --mode cli-workdir`.
Every invariant value must equal the matching authorized leaf, including the complete deterministic
`BundleEvidence`. The writer records new observation times in the private ledger. Any guard, native-
runtime, target, quarantine, external window, ledger, object, role, ACL, row, queue, freeze or byte
change refuses before child creation.

The writer then opens the short transaction-held migration-ledger relation barrier and asks the
minimal root launcher to spawn `/usr/local/libexec/supabase` inside the already measured private root
namespace, with the bound apply
application name, fixed `/operation` work directory and exact validated project reference supplied
explicitly through `--project-ref`. It never resolves host `PATH` and never permits linked or default
target selection. Its fixed request contains the complete signed grant and ticket plus the retained
evidence leaves, and the launcher must complete the root-journal `consumed` to `executing` transition
described above before it creates any execution resource. The launcher then returns a pidfd and
performs no arbitrary command or credential operation; the child has the exact bound unprivileged
identity, empty capabilities, process protections and egress policy before receiving its phase-
scoped environment. Read-only root-image custody and the retained mount identity prevent a front-
controller, delegate, interpreter, dependency or path swap between final measurement and process creation. The
relation barrier remains held until the exact waiting-session handoff succeeds. After it is released,
the session-level database guard remains held only until the same backend is durably observed waiting
for the first migration's advisory lock; it is then released within the bounded handoff budget so the
migration can proceed.

The guarded operation writes the envelope only to private evidence storage and reports its SHA-256
for attended authorization. Apply authorization names that envelope digest. Before invoking the
measured native CLI topology, the guarded writer verifies the root authority's already-consumed signed
grant and ticket and atomically records their digests in its separate execution ledger. The root
launcher independently enforces and persists the authoritative `consumed` to `executing` transition.
An expired, unconsumed or already-executing nonce refuses without spawning the CLI. Failure after
root consumption requires the exact `terminal_no_spawn` proof above or remains quarantined for
read-only reconciliation. A later attempt is a new operation and authorization; it never reuses or
resets the grant, ticket or nonce.

Before relation-barrier release, the operation ledger appends one canonical private session-binding
leaf:

```json
{
  "schemaVersion": "openspell.hosted-migration-session-binding.v1",
  "handoffPhase": "ledger_barrier",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "applySessionTagSha256": "...",
  "runtimeAttestationChainPrefixSha256": "...",
  "runtimeAttestationObservedExecCount": 1,
  "cliChildPid": 456,
  "cliChildStart": "...",
  "guardBackendPid": 123,
  "guardBackendStart": "...",
  "cliBackendPid": 789,
  "cliBackendStart": "...",
  "lockType": "relation",
  "targetDatabaseOid": 16384,
  "relationOid": 16385,
  "blockedRelation": "supabase_migrations.schema_migrations",
  "requestedLockMode": "AccessShareLock",
  "granted": false,
  "blockingBackendPids": [123],
  "backendState": "active",
  "waitEventType": "Lock",
  "waitEvent": "relation",
  "observedAt": "..."
}
```

The runner accepts exactly one matching backend at handoff, requires its application name to hash to
the authorized apply-session tag digest, proves its ungranted relation-lock row names the fixed
migration-ledger relation and exact lock mode established by disposable proof, and requires its only
blocking backend to be the recorded guard. The only accepted mode is `AccessShareLock`; a different
exact-CLI observation changes the architecture and must return to review. The attestation count is
exactly one or two according to the bound phase topology, and the prefix must end at the proved
database-owning executable before this backend can be accepted. It records the leaf before releasing
the relation barrier. This post-spawn leaf is an audit result, not a value that can be predicted and
inserted into the pre-spawn authorization envelope.

Both OIDs are positive decimal integers observed from the approved target. `relationOid` must resolve
to the canonical relation name in `targetDatabaseOid`; `granted` is exactly false; and both wait-event
fields must equal the shown PostgreSQL values. `backendState` is PostgreSQL's exact observed `active`
state; waiting is established by `granted`, wait-event and blocker evidence rather than a fabricated
backend state. These decisive observations are retained in the leaf, not inferred later from the
normalized relation name.

Before releasing the advisory guard, the operation ledger appends a second canonical private
handoff leaf:

```json
{
  "schemaVersion": "openspell.hosted-migration-advisory-handoff.v1",
  "handoffPhase": "migration_advisory_guard",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "applySessionTagSha256": "...",
  "cliChildPid": 456,
  "cliChildStart": "...",
  "guardBackendPid": 123,
  "guardBackendStart": "...",
  "cliBackendPid": 789,
  "cliBackendStart": "...",
  "lockType": "advisory",
  "targetDatabaseOid": 16384,
  "advisoryKey": "wizard-ads:schema-ddl:v1",
  "advisoryClassId": 1,
  "advisoryObjectId": 2,
  "advisoryObjectSubId": 1,
  "requestedLockMode": "ExclusiveLock",
  "granted": false,
  "blockingBackendPids": [123],
  "otherHolderCount": 0,
  "otherWaiterCount": 0,
  "backendState": "active",
  "waitEventType": "Lock",
  "waitEvent": "advisory",
  "waitQueryStartedAt": "...",
  "waitObservedAt": "...",
  "waitAgeAtObservationMilliseconds": 10,
  "waitObservedMonotonicNanoseconds": "..."
}
```

The runner accepts this second handoff only for the same owned child and same backend identity as the
ledger binding, with exactly one ungranted advisory-lock row for the fixed key, the guard as its sole
blocker and no other holder or waiter. It persists and syncs the leaf before releasing the guard
within the proven one-second budget.

The database OID must equal the first handoff. The observed advisory class, object and sub-object IDs
must equal PostgreSQL's exact representation of the 64-bit hash for the fixed advisory key;
`advisoryObjectSubId` is exactly `1`. `granted` is false and both wait-event fields equal the shown
values. `backendState` is exactly `active`. `otherHolderCount` excludes the recorded guard, while
`otherWaiterCount` excludes the bound CLI waiter; each is exactly zero. The same database query
returns `waitQueryStartedAt`, `waitObservedAt` and their integer millisecond difference;
`waitAgeAtObservationMilliseconds` must be at most 250. The supervisor captures the same-boot
monotonic timestamp before it persists the handoff leaf.

After the database confirms release, the supervisor appends and syncs this canonical private result
leaf before accepting apply progress:

```json
{
  "schemaVersion": "openspell.hosted-migration-advisory-release.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "targetFingerprint": "...",
  "applySessionTagSha256": "...",
  "advisoryHandoffEvidenceSha256": "...",
  "guardBackendPid": 123,
  "guardBackendStart": "...",
  "cliBackendPid": 789,
  "cliBackendStart": "...",
  "waitObservedAt": "...",
  "releaseRequestedAt": "...",
  "releasedAt": "...",
  "releaseBudgetMilliseconds": 1000,
  "waitAgeAtObservationMilliseconds": 10,
  "handoffToReleaseElapsedMilliseconds": 15,
  "releaseResult": "released",
  "targetQuarantineState": "held",
  "enqueueFreezeState": "held"
}
```

`advisoryHandoffEvidenceSha256` binds the complete preceding handoff leaf, and `waitObservedAt` and
`waitAgeAtObservationMilliseconds` must match it exactly. The three wall times are UTC RFC 3339 with
milliseconds and `Z`. `handoffToReleaseElapsedMilliseconds` runs from the handoff leaf's pre-sync
monotonic timestamp through confirmed database unlock, so it includes durable handoff persistence
and the release round trip. Both elapsed values are nonnegative integers and their sum must be at
most the exact 1000-millisecond budget. Missing or late confirmation, a release error, loss of the
guard connection, failure to sync either leaf, or a changed target-quarantine/freeze state becomes
durably ambiguous. If the remaining budget cannot close before unlock, the supervisor terminates the
still-blocked child/cgroup/session while the guard is known held. A crash after release but before
this leaf syncs also reconciles as ambiguous; it never causes another spawn. The runner then monitors
every backend with the exact apply tag until the child is terminal. An unexpected additional exact-
tag session, another holder or waiter on the fixed advisory key, or a session/lock topology that
violates the exact-CLI disposable proof is ambiguous. Normal migration relation/catalog locks and the
bound CLI session's expected granted transaction advisory lock are valid progress. A backend identity
change is accepted only when the disposable 2.116.0 topology explicitly proves and binds that
transition; otherwise it is ambiguous. None of these outcomes authorizes a retry.

If the second binding cannot be established while the advisory guard is known held, the supervisor
terminates the entire operation cgroup and proves the direct child terminal, the cgroup empty and
zero exact-apply-tag sessions before it releases the guard. It then enters read-only reconciliation
under a newly acquired target-bound guard; it does not spawn again. If guard custody is lost before
that termination proof closes, the operation remains quarantined under the general ambiguous-outcome
path and must never be classified as blocked or no-op from process exit alone.

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

Postflight also revalidates the same root-signed external-window digest and generation, actor roster,
credential inventory, held state and expiry before classifying success. A changed, expired or
unverifiable window leaves the operation quarantined and ambiguous; it cannot be repaired by a local
journal edit or operator assertion after the fact.

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
exact native CLI's phase-specific application-name propagation, migration-ledger relation-lock mode,
first wait behind the relation barrier, the same backend's second wait on the first migration
advisory lock, bounded advisory-guard release, child/cgroup/session termination and guarded response-
loss reconciliation. Until that private runner and proof exist, the public probe supplies review
evidence only and no session-binding or apply-safety claim exists.

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
- do not put an executable `supabase db push` command or any real project-reference value in the
  public builder or runbook; the non-executable fixed future-supervisor argv contract is allowed;
- do not trust an old cached snapshot for a later production action;
- do not track the generated 46-file bundle;
- do not combine artifact construction with hosted apply, credential work, staging, activation,
  scoped admission, deployment, QA or Amazon operations.
