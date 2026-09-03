# WP-197 — Exact hosted migration bundle

Owner: offline hosted-history artifact construction and verification.

Depends on: merged WP-196 closeout and source migration order through WP-196.

Architecture: `docs/design/WP-197-ARCHITECTURE.md`.

## Objective

Build a deterministic, source-only tool that preserves the exact 41-file hosted migration prefix,
appends the five exact reviewed WP-187/WP-192/WP-194/WP-195/WP-196 Git blobs and independently
verifies one sanitized 46-file migration bundle for later review.

WP-197 is offline and inert. It does not fetch hosted state, invoke Supabase or PostgreSQL, apply a
migration, repair history, change credentials, stop or stage a service, activate authority, deploy
web, run production QA, call a provider or mutate Amazon.

## Owned files

- WP-197 architecture and this work-package brief;
- new `tools/hosted-migration-bundle` package and focused tests;
- root workspace command and lockfile entries required to run the package;
- public-safe bundle construction/review runbook;
- one transaction-read-only universal catalog/ledger probe and six prefix-specific evidence scripts
  for later preflight, postflight and ambiguous-response reconciliation.

Do not edit `packages/shared`, existing migrations, application or worker runtime, service units,
credentials, Supabase configuration, seeds, handover or status. Handover and status change only
after reviewed merge and exact-main CI.

## Required behavior

1. Expose only `build` and `verify`. Accept a history work directory, new output work directory and
   exact full source revision; `verify` also requires `sealed` or `cli-workdir` mode. Accept no
   target, credential, database, CLI or apply parameter.
2. Require a clean checkout where `HEAD`, local `origin/main` and the requested 40-hex revision are
   identical. Never fetch or mutate Git state.
3. Inspect only the input's `supabase/migrations`. Do not traverse, read, copy or manifest `.temp`,
   linked-project metadata, configuration or any sibling input.
4. Require exactly the fixed 41 regular hosted-history SQL files, 279677 bytes, ending at version
   `20260901010000`, with canonical ledger digest
   `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea`.
5. Treat the 41 files as opaque byte-authoritative hosted history. Never compare them to, overwrite
   them from, rename them from or replay them against repository history.
6. Read only the five fixed pending migration paths as Git blobs at the approved revision. Require
   their exact sizes, hashes and order through `20260901060000`.
7. Refuse missing, changed, renamed, duplicate, extra, non-regular, symlinked or hard-linked input;
   pending-version collision; overlapping paths; repository-contained output; and existing output.
8. Snapshot all accepted input bytes, hold and recheck the canonical output-parent identity, and on
   Linux claim the non-existent output basename through `/proc/self/fd/<parent-fd>/`. Immediately
   open and retain the claimed output inode. Perform every post-claim marker, payload, private-check
   and sync operation through `/proc/self/fd/<output-fd>/`, while rechecking canonical parent/output
   bindings against both held descriptors. Create a fixed unpublished marker before any payload
   file. The private marked-tree checker requires the marker; public `verify` rejects it. Remove the
   marker only after complete verification, then sync the directory; marker removal is the
   publication commit point. `build` requires Linux with mounted, usable `/proc/self/fd` and fails
   closed otherwise; `verify` may remain portable. Never overwrite an output created by a race or
   recursively delete a path after custody is uncertain. No pre-commit failure may expose a
   verifiable bundle, and response loss after the commit point must reconcile through `verify`.
9. Emit only `supabase/migrations/*.sql` and deterministic `BUNDLE_MANIFEST.json` after publication.
   Serialize the manifest as UTF-8 without a byte-order mark, with exact documented key order,
   two-space JSON indentation and one terminal line feed. It contains exact provenance, counts,
   sizes and hashes but no time, absolute path, target identity, CLI version, credential,
   environment value or SQL body.
10. Independently verify all 46 files, 646628 bytes, terminal version `20260901060000`, bundle ledger
    digest `baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`
    and exact manifest shape before returning success.
11. Print bounded JSON evidence containing only the source revision, counts, sizes, terminal version,
    ledger digests and manifest digest. Sanitize every failure.
12. Use only local filesystem, path, crypto, process and fixed Git-object operations. Static proof
    must deny Supabase, PostgreSQL, HTTP/network, browser, secret-manager, provider, service-manager,
    deployment and apply reachability.
13. Keep the sealed bundle outside Git and never use it as a Supabase CLI work directory. Any later
    CLI check uses a fresh writable disposable clone. `verify --mode cli-workdir` must close the
    exact migrations and manifest after dry run and immediately before apply while ignoring rather
    than trusting exactly `supabase/.temp`. It rejects every other extra entry and never traverses
    or reads `.temp`.
14. Provide one reviewed no-parameter static read-only probe that selects exactly one of six static
    read-only prefix scripts and returns aggregate counts for other granted/waiting holders of the
    shared schema-DDL key and fixed-prefix guarded-CLI sessions. Each script must close its exact
    contiguous prefix from 41 through 46 without referencing a relation created by a later prefix,
    exposing target or session identity, using dynamic SQL or mutating state. An unguarded
    probe/prefix/probe sandwich is review evidence only because it cannot close its transaction gaps.
15. Describe fresh history fetch, target identity, exact CLI binary, dry run, enqueue freeze, apply,
    response-loss recovery, credentials, staging, activation, scoped admission, deployment and QA as
    separate later gates. The separately authorized enqueue freeze must be held before final
    preflight through apply, reconciliation and postflight. Include no non-dry-run apply command in
    this package.
16. Make every prefix script return the same named queue, recommendation, schedule and out-of-scope
    privilege fingerprints. The guarded runner must compare each current value to preflight, emit a
    canonical pass/fail comparison record and refuse an operational envelope on any mismatch.
17. Bind separate phase-stamped pre-apply target and freeze leaves into the private envelope. A
    future guarded writer must hold a separate target lock and one target-bound database session with
    the non-waitingly acquired session-level schema-DDL advisory lock. On that same session it runs
    probe, selected prefix and probe again; both complete probe rows must be byte-identical and all
    prefix evidence must equal the authorization. After consuming a single-use nonce and before
    spawning the CLI, it must rerun that guarded sandwich plus target, fingerprint comparison,
    freeze and CLI-workdir byte checks.
18. Generate operation ids and authorization nonces inside the guarded operation as independent 256-
    bit cryptographic-random values. Enforce separate uniqueness constraints, refuse collisions,
    expire authorization within 15 minutes and never accept either value from a caller.
19. Require a guarded-service-private mode-`0700` CLI work directory. Make its manifest, migration
    files and migration directories non-writable after dry run, leave only `supabase/.temp`
    writable, and hold exclusive custody through final verification and child-process exit.
20. Copy the reviewed Supabase CLI executable into the private operation directory, make it
    non-writable and bind its relative path, device, inode, size, hash, version and provenance. After
    nonce consumption, remeasure every field and spawn that exact canonical path without resolving
    `PATH`, following a symlink or invoking a wrapper. Give it an operation-private `PGAPPNAME`; exact
    CLI disposable proof must show every opened database connection carries the complete tag.
21. Derive target fingerprint and target-selection digest from the same exact 20-character project
    reference. Pass that reference explicitly with `--project-ref` for dry run and apply; never allow
    linked or default target selection.
22. Derive an operation-private session tag from the broker-generated operation id and nonce. The
    advisory lock is a coordination guard, not a CLI barrier. Immediately before spawn, take a bounded
    non-waiting `ACCESS EXCLUSIVE` transaction lock on the existing migration-ledger relation. Bind the
    owned child process to exactly one tagged target backend blocked solely by the guard on that exact
    relation with exactly `AccessShareLock`, as established by exact-CLI disposable proof. Missing, duplicate,
    untagged, differently blocked or multiply blocked sessions refuse while the child remains blocked.
    Release only the relation barrier after the handoff; keep the session advisory guard and broker
    target lock through terminal child custody, reconciliation and postflight. This handoff and the
    guarded runner are later private capabilities; the public probe and offline bundle tool do not
    implement or claim them.
23. Give the private operation ledger custody of the CLI process id, process-start identity and
    terminal state. On response loss, first prove that exact child terminal, then validate the still-
    held database guard or reacquire it non-waitingly under attended ambiguous-outcome recovery.
    Require zero sessions with its exact private tag and run the guarded probe/prefix/probe sandwich.
    Refuse reconciliation or suffix authorization on any uncertainty. A new suffix uses a new
    operation id, nonce, session tag, evidence and authorization.

## Exact additions

| Work package | Migration | Bytes | SHA-256 |
|---|---|---:|---|
| WP-187 | `20260901020000_sp_write_persistence_ledger.sql` | 179749 | `d28e2c3630ac4b59732cde8bb7021ae955c9b36f0b58d0567a7751c14259df67` |
| WP-192 | `20260901030000_sp_write_outbox_delivery.sql` | 46611 | `c34fc0a1902abe27f0c33d66c1a083fb32f0fd5df30974baecace674a2219a2c` |
| WP-194 | `20260901040000_fenced_sync_claims.sql` | 20101 | `ec96b16f6c2c487404ee15d24cdf58d40d2d079ed0ed12fd5b12bc7abbcd9bf2` |
| WP-195 | `20260901050000_recommendation_preview_scopes.sql` | 6379 | `af126c432ca8d523d7483139de3cbf267f3c1d2c68a14b236f2b171fc3811021` |
| WP-196 | `20260901060000_recommendation_claim_custody.sql` | 114111 | `937fe566de09413df7a7578bcd3889c36d4465b81c6d03ad0a1773ca3cf0cb84` |

## Proof requirements

- exact 41/5/46 counts, 279677/366951/646628 byte totals, filename ordering, terminal versions and
  canonical ledger digests close;
- current repository policy proof independently hashes all five Git blobs;
- a modified working-tree migration cannot influence output;
- every missing, changed, renamed, duplicate, extra or out-of-order baseline case refuses output;
- every changed, absent or colliding addition refuses output;
- symlink, non-file, hard-link, overlap, repository-contained output and existing-output cases fail
  closed;
- mutation between validation and copy, staged-output mutation and manifest mutation cannot verify;
- injected crash before marker removal leaves no accepted artifact, while lost response after
  marker removal reconciles to the exact published artifact;
- repeated construction from identical inputs produces byte-identical output and evidence;
- manifest schema, keys, entry order, provenance, counts, hashes and sanitized contents are exact;
- `.temp`, target linkage and every unrelated input remain absent from output;
- static source and spawned-command inventory contains no external-state mutation or mutating
  subprocess capability; only the bounded local artifact writes in this contract are allowed;
- the universal probe and all six prefix scripts are transaction-read-only, bounded and contain no
  dynamic execution or sensitive target data;
- disposable upgrade-shaped proof models each valid committed prefix from 41 through 46 with its
  exact ledger digest, schema/ACL/role/row invariant set and forward-only suffix resume;
- prefix-46 evidence closes every recommendation-role attribute, password/expiry/connection state,
  membership edge, function owner and ACL, schema/table/sequence grant, default ACL and executor RLS
  policy against the exact additions/removals/replacements transition matrix;
- final preflight proves the separately authorized enqueue freeze is held and binds the same queue
  fingerprint through apply, ambiguity reconciliation and postflight;
- canonical comparison evidence proves current queue, recommendation, schedule and out-of-scope
  privilege fingerprints equal their preflight values before any envelope can be authorized;
- private evidence binds one target fingerprint and one measured Supabase CLI 2.116.0 executable to
  fetch, dry run, apply, reconciliation and postflight without entering the public bundle;
- post-dry-run and immediate pre-apply verification closes the writable CLI clone against the
  authorized manifest and bundle-ledger digests;
- separate phase-bound CLI-workdir observations, a fresh operation id/nonce, 15-minute expiry and
  consume-before-spawn private ledger rule prevent observation reuse and apply replay, including
  same-prefix suffix recovery;
- after nonce consumption, the guarded writer's final pre-spawn rerun closes target identity,
  current prefix/schema, preflight fingerprint equality, held freeze and exact local bytes against
  the authorized leaves before invoking the CLI;
- the final pre-spawn check remeasures the broker-private Supabase executable and explicit target-
  selection record, then spawns only that exact non-writable binary with the exact `--project-ref`;
- process-custody, target-lock and database-guard proofs prevent response-loss reconciliation while
  the original apply can still advance, and the non-writable private clone prevents migration-byte
  changes after final verification;
- Linux publication-race tests prove the output is claimed beneath a held parent descriptor and all
  later marker/payload operations stay beneath the held output descriptor; `build` refuses when
  `/proc/self/fd` custody is unavailable;
- public probe evidence closes other shared-lock holders/waiters and guarded-CLI session aggregates
  without exposing backend or target identity; its unguarded sandwich is never accepted as apply
  authorization;
- disposable exact-CLI proof closes `PGAPPNAME` propagation to every database connection, the exact
  migration-ledger `AccessShareLock` and pre-migration blocking point, one tagged waiting-session handoff
  behind the short relation barrier, child/session termination, guarded reconciliation and refusal
  of absent, duplicate or ambiguous sessions;
- provider-negative evidence is limited to unchanged OpenSpell-observable provider/write ledgers,
  empty new SP state and static absence of provider capability;
- full repository typecheck, lint, tests, hygiene and skill lint pass.

## Review split

- High correctness review owns fixed-policy encoding, Git provenance, filesystem safety,
  deterministic manifest/evidence and negative tests.
- Extra-High adversarial migration review owns target-prefix ambiguity, role/ACL and queue
  fingerprints, response-loss reconciliation, forward-only recovery and action-boundary separation.

Neither review may use hosted credentials, query production, stage a service or apply a migration.

## Acceptance checks

- [x] Architecture and work-package contract committed separately before implementation.
- [x] Exact baseline/addition policy and canonical digest format pass High and Extra-High review.
- [x] Builder constructs and independently verifies exactly 46 migrations with all grounded counts
      and digests.
- [x] No `.temp`, project binding, credential, profile data, absolute tracked path or external-state
      metadata enters output or logs.
- [x] Tamper, race and failure-injection proofs show no partial artifact can verify.
- [x] Static proof shows no Supabase, database, network, provider, deployment or apply capability.
- [x] Read-only SQL and disposable partial-prefix/resume model pass adversarial review.
- [x] Focused tests, full `pnpm check`, staged hygiene and `git diff --check` pass.
- [ ] Exact-head pull-request CI and exact-main CI pass both jobs.
- [x] This package performs no hosted query, migration apply, credential operation, staging,
      activation, deployment, provider or Amazon action.
- [ ] Handover and status update only after reviewed merge and exact-main CI.

## External gates

Merging WP-197 authorizes no hosted action. A fresh read-only hosted-history fetch and exact dry-run
evidence are required before any application can be proposed. The later operator apply must receive
its own authorization naming the exact revision, manifest digest, bundle-ledger digest, private
target fingerprint, CLI semver and binary digest, held enqueue-freeze evidence, writable-clone
verification and observed prefix-evidence digest.
Credential provisioning, report/recommendation worker staging, claim-authority handoffs, scoped
admission, candidate web deployment, bounded live QA and production web promotion each remain
separate exact authorizations. Amazon mutation remains locked behind the distinct parity and
write-activation program gates.
