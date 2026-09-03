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
15. Describe fresh history fetch, target identity, exact native CLI payload, dry run, enqueue freeze,
    apply, response-loss recovery, credentials, staging, activation, scoped admission, deployment and
    QA as separate later gates. The separately authorized enqueue freeze must be held before final
    preflight through apply, reconciliation and postflight. Include no executable or copy-paste
    operator apply procedure and no apply capability in this package; a non-executable canonical argv
    contract for the later private supervisor is allowed.
16. Make every prefix script return the same named queue, recommendation, schedule and out-of-scope
    privilege fingerprints. The guarded runner must compare each current value to preflight, emit a
    canonical pass/fail comparison record and refuse an operational envelope on any mismatch.
17. Bind separate phase-stamped pre-apply target and freeze leaves into the private envelope. A
    future guarded writer must claim and sync a durable private target quarantine before native-
    runtime preparation or any target-connected phase, bind its generation and evidence digest, and
    hold it through exact postflight. One authoritative root-owned journal and host-global singleton
    lock own every generation; missing, duplicate or corrupt authority refuses startup. A valid
    nonterminal or ambiguous record permits recovery-only status/reconcile but no prepare, latch,
    spawn or generation. A root-signed, generation-bound external-operation window covers the exact
    manual, other-host, scheduled and broker actor roster and credential inventory. Bind its digest
    into the envelope and root latch, revalidate it after approval consumption and require the same
    held generation through postflight. It must also hold one target-bound database session with the
    non-waitingly acquired session-level schema-DDL advisory lock. On that same session it runs probe,
    selected prefix and probe again; both complete probe rows must be byte-identical and all prefix
    evidence must equal the authorization. After root consumption of a single-use signed grant and before spawning the
    CLI, it must rerun that guarded sandwich plus target, fingerprint comparison, quarantine, freeze
    and CLI-workdir byte checks.
18. Generate operation ids and authorization nonces inside the guarded operation as independent 256-
    bit cryptographic-random values. Enforce separate uniqueness constraints, refuse collisions,
    expire authorization within 15 minutes and never accept either value from a caller.
19. Require a guarded-service-private mode-`0700` CLI work directory. Make its manifest, migration
    files and migration directories non-writable after dry run, leave only `supabase/.temp`
    writable, and hold exclusive custody through final verification and child-process exit.
20. Pin the official `supabase/cli` `v2.116.0` checksum-asset, Linux archive and extracted binaries'
    digests in reviewed root-owned policy. An attended root acquisition must download into a new
    root-owned non-agent-writable source, verify the complete chain and reject a package-manager
    cache, user download, copied executable or any agent-writable path ancestor. Extract and bind the
    archive's exact `supabase` front controller plus co-located `supabase-go` delegate, rejecting
    extra entries, symlinks, environment overrides and host launchers. Copy both binaries, the front-
    controller interpreter and resolved dependency set into the private operation's non-writable
    runtime image; bind the canonical official-source, native-runtime, image, release-provenance and
    phase exec-topology-policy digests. Before every phase and after approval consumption, remeasure
    every field and spawn only the measured front controller inside the retained runtime, without
    resolving `PATH` or using a shell. Exact CLI disposable proof must close the only allowed phase-
    specific exec graph, show every opened database connection carries the complete phase tag and
    show each completed phase leaves zero matching sessions.
21. Derive target fingerprint and target-selection digest from the same exact 20-character project
    reference. Pass that reference explicitly with `--project-ref` for history fetch, dry run and
    apply; never allow linked, local, database-URL or default target selection.
22. Derive separate operation-private history-fetch, dry-run and apply tags from the supervisor-generated
    operation id and nonce. Immediately before apply spawn, take a bounded non-waiting `ACCESS
    EXCLUSIVE` transaction lock on the existing migration-ledger relation. Bind the owned child to
    exactly one apply-tagged backend blocked solely by the guard on that relation with exactly
    `AccessShareLock`, as established by exact-CLI disposable proof. A missing exact tag, duplicate
    matching session, different blocker or multiple blockers refuse while the child remains blocked;
    disposable proof must establish that this exact CLI opens no untagged target connection. After
    durably recording that first binding, release only the relation barrier and require the same
    backend to become the sole waiter for the pending migration's transaction advisory lock, blocked
    only by the session guard. Require its database-observed wait age plus durable binding persistence
    and confirmed unlock to total at most one second, then record the confirmed release, elapsed time
    and still-held target-quarantine/freeze state before accepting apply progress. Retain the durable target
    quarantine and enqueue freeze, not the advisory guard, through apply and postflight. This two-stage
    handoff and guarded runner are later private capabilities; the public probe and offline bundle
    tool do not implement or claim them.
23. Give the private operation ledger custody of the CLI process id, process-start identity, dedicated
    CLI-child cgroup and terminal state; that cgroup contains the child and descendants but excludes
    the supervisor and database-guard session. On response loss, first prove that exact child terminal,
    the cgroup empty and zero sessions with the exact apply tag. Only then open a new target-bound
    database guard session and reacquire the advisory lock non-waitingly before the guarded probe/
    prefix/probe sandwich. Refuse reconciliation or suffix authorization on any uncertainty. A new
    suffix uses a new operation id, nonce, all three phase tags, evidence and authorization.
24. Keep the applying supervisor in a dedicated unprivileged deployment-private service identity and
    mode-`0700` state, separate from the agent-accessible general broker. Agent-accessible operations
    may only prepare, report status and reconcile read-only. Apply requires a separate root/operator-
    only, freshly OS-authenticated, single-use signed grant binding the exact envelope, operation,
    nonce, target, external-window generation and expiry with peer/session identity and durable
    audit. Specify canonical Ed25519-signed grant and ticket leaves, domains, raw key/signature
    formats and exact `approved` to `consumed` to `executing` to `terminal` root-journal transitions.
    Also define the only no-execution branch: a root-signed, fsynced `consumed` to
    `terminal_no_spawn` result is allowed only when compare-and-set proves `executing` was never
    entered and root-launcher plus zero-session evidence proves no namespace, cgroup, child or pidfd
    existed. Ambiguity remains quarantined.
    Only the root authority can issue and atomically consume the grant; its key and approval journal
    are inaccessible to the supervisor. The minimal root launcher must independently verify the
    grant and ticket and fsync `consumed` to `executing` before creating any execution resource. The
    supervisor records only a separate non-authorizing receipt. Agent chat or broker access cannot
    satisfy it.
25. Bind fixed per-phase argv, cwd, stdin, strict environment and output policies. A minimal root
    launcher may create namespaces and the child-only cgroup but receives no provider credential and
    exposes no arbitrary execution. It retains trace custody across every fork/clone/exec, validates
    the measured namespace/executable/maps and exact phase exec graph, re-establishes and verifies
    non-dumpability after each ELF exec reset, and signs actual cgroup/runtime attestations. The
    relation handoff binds the ordered attestation chain through the proved database-owning exec
    prefix and exact observed exec count; the terminal graph must extend it. Only
    helper identity plus cgroup/sandbox/topology policy are preauthorized; pid, cgroup inode and
    runtime observations are post-spawn evidence. The CLI runs as a dedicated non-login uid/gid with
    empty capabilities, `no_new_privs`, non-dumpable/core-disabled process state, protected
    environment, fixed syscall policy and target-only egress. Reject personal, organization-wide,
    broad service, cross-project and `service_role` credentials; inability to prove exact CLI
    operation with a target-scoped credential is a production no-go. History fetch,
    dry run and apply use only the reviewed native-runtime path, explicit `--project-ref`, fixed
    private `--workdir`, `--yes` and noninteractive output. Both push phases require `--skip-vault`;
    dry run alone has `--dry-run`. No caller flags, shell, linked/local/database-URL selection,
    include-all/roles/seed, debug, proxy, loader or executable-override channel is permitted.
26. Give history fetch and dry run separate canonical Ed25519-signed, single-use preparation tickets
    with `writeCapability:false`, exact phase/argv/runtime/topology/sandbox/cgroup binding and their
    own root-journal lifecycle. They cannot name apply or another phase. Runtime-attestation and
    terminal-graph leaves bind a generic phase-authorization kind/digest: the applicable preparation
    ticket for those two phases and the attended execution ticket only for apply. Bind both completed
    preparation-phase terminal graphs into the later envelope. Define a distinct canonical signed,
    fsynced `prepared` to `terminal_no_spawn` result allowed only when compare-and-set proves
    `executing` was never entered and root-launcher plus zero exact-phase-session evidence proves no
    resource existed. Any uncertainty stays recovery-only; abandonment/new generation requires all
    issued preparation phases terminal or conclusively no-spawn.

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
- private evidence binds one target fingerprint and the measured official two-binary Supabase CLI
  2.116.0 topology to fetch, dry run and apply without entering the public bundle;
- post-dry-run and immediate pre-apply verification closes the writable CLI clone against the
  authorized manifest and bundle-ledger digests;
- separate phase-bound CLI-workdir observations, a fresh operation id/nonce, 15-minute expiry and
  root-consume-before-spawn grant plus execution-receipt rule prevent observation reuse and apply replay, including
  same-prefix suffix recovery;
- a durable per-target quarantine is claimed and synced before native-runtime preparation or any
  target-connected phase, is bound into the authorization, and survives process/service failure until
  exact reconciliation and postflight release it;
- after root grant consumption, the guarded writer's final pre-spawn rerun closes target identity,
  current prefix/schema, preflight fingerprint equality, held freeze and exact local bytes against
  the authorized leaves before invoking the CLI;
- the final pre-spawn check remeasures the supervisor-private official Supabase binary pair and
  explicit target-selection record, then spawns only the exact non-writable front controller with
  the exact `--project-ref`;
- an independently pinned official release chain and root-only acquisition prevent an agent-writable
  executable from entering the measured topology, while root-signed post-exec attestations prove the
  actual cgroup, binary graph, maps and process protections without relying on the unprivileged
  supervisor to inspect another uid;
- process/cgroup custody, durable target quarantine, separate phase tags and exact database-session
  proofs prevent response-loss reconciliation while the original apply can still advance, and the
  non-writable private clone prevents migration-byte changes after final verification;
- canonical signed external-window, grant and execution-ticket records remain outside supervisor
  write authority; the root launcher enforces their one-use state transition at spawn, and their
  complete tuple remains bound through final pre-spawn and postflight;
- Linux publication-race tests prove the output is claimed beneath a held parent descriptor and all
  later marker/payload operations stay beneath the held output descriptor; `build` refuses when
  `/proc/self/fd` custody is unavailable;
- public probe evidence closes other shared-lock holders/waiters and guarded-CLI session aggregates
  without exposing backend or target identity; its unguarded sandwich is never accepted as apply
  authorization;
- disposable exact-CLI proof closes phase-specific `PGAPPNAME` propagation to every database
  connection, the exact migration-ledger `AccessShareLock`, the first tagged wait behind the relation
  barrier, the same backend's second wait on the first migration advisory lock, a durable confirmed
  release record proving wait age plus handoff sync and unlock took at most one second,
  child/cgroup/session termination, guarded
  reconciliation and refusal of absent, duplicate or ambiguous sessions;
- root-signed non-write preparation tickets and completed terminal graphs close history/dry-run
  runtime provenance before the envelope without circular dependence on its later apply ticket;
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
- [x] Exact-head pull-request CI and exact-main CI pass both jobs.
- [x] This package performs no hosted query, migration apply, credential operation, staging,
      activation, deployment, provider or Amazon action.
- [x] Handover and status update only after reviewed merge and exact-main CI.

## External gates

Merging WP-197 authorizes no hosted action. A fresh read-only hosted-history fetch and exact dry-run
evidence are required before any application can be proposed. The later operator apply must receive
its own authorization naming the exact revision, manifest digest, bundle-ledger digest, private
   target fingerprint, CLI semver, official two-binary source, runtime image, identity, exec-topology
   and child-sandbox policy digests, held target-quarantine, root-signed external-window generation,
   enqueue-freeze evidence, writable-clone verification and observed prefix-evidence digest. The
   operator authorization names this envelope; the later execution receipt and postflight bind the
   root-consumed signed ticket rather than making that future ticket an authorization prerequisite.
Credential provisioning, report/recommendation worker staging, claim-authority handoffs, scoped
admission, candidate web deployment, bounded live QA and production web promotion each remain
separate exact authorizations. Amazon mutation remains locked behind the distinct parity and
write-activation program gates.
