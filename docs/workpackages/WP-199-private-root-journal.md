# WP-199 — Private root journal and fixed IPC

Owner: offline root-authority journal, strict IPC codecs and one-use approval/ticket transitions.

Depends on: merged WP-198 closeout and exact-main CI at
`b61da3a121651c059260c8a28e1d4e5bdf6500bd`.

Architecture: `docs/design/WP-199-ARCHITECTURE.md`.

## Objective

Implement a source-only Rust library and test harness that independently creates and verifies the
exact WP-197 approval-grant and execution-ticket records in a test-only composition, persists one
immutable authoritative journal chain, enforces one-use durable compare-and-set transitions and
decodes separate fixed operator/supervisor protocol surfaces over injected Linux Unix handles.

WP-199 is not deployable. It has no binary, listener installation, production key loader, launcher,
network, database, Supabase, credential, service unit or live-host operation.

## Owned files

- `docs/design/WP-199-ARCHITECTURE.md` and this work-package brief;
- new `tools/hosted-migration-root-authority/` source-only workspace package;
- its pinned Cargo manifest, lockfile and toolchain file;
- its TypeScript test configuration and test-only WP-198 cross-oracle vectors;
- the root pnpm lockfile entry if required for workspace discovery.

Do not edit `packages/shared`, existing packages, applications, migrations, Supabase configuration,
deployment/service files, CI workflows, WP-198 implementation, handover or status during
implementation. Handover and status change only after reviewed merge and exact-main CI.

## Required behavior

1. Build a Rust library only. Set `publish = false`, emit only an `rlib`, disable automatic binary,
   example and benchmark targets and expose no public callable item. Publish no binary, CLI,
   installer, listener path, service or npm export. Use a private `tools/*` package solely to
   integrate Cargo checks with Turbo.
2. Forbid unsafe code. Pin the Rust toolchain and complete Cargo dependency graph. Production
   modules may use only fixed-descriptor filesystem, Unix-peer, canonical JSON, SHA-256 and exact
   Ed25519 record capabilities.
3. Preserve the broker-to-supervisor `prepare/status/reconcile` vocabulary as a contextual
   constraint owned by WP-198. Define only the two nonmultiplexed root protocol families:
   supervisor registration/status/consume and attended-helper approval/expired closure. Implement
   those only through crate-private test composition over already-open handles.
4. Use separate decoders and handlers for operator and supervisor messages. No role byte or generic
   method dispatcher may cross from one authority surface to another.
5. Accept no caller-selected target slot, root policy, phase, apply flag, path, command, environment,
   credential, URL, SQL, retry, trusted-clock value, nonce, signer or response detail. Treat every
   supervisor candidate field as untrusted.
6. Require connected Linux `AF_UNIX/SOCK_SEQPACKET`, `SO_PASSCRED`, exact connection and per-message
   credentials, one complete record followed by peer write-half shutdown, and the exact bounded
   frame/opcode/payload schemas and 16 KiB complete-record cap from the architecture. Refuse wrong
   endpoint/socket/peer, `SCM_RIGHTS`, extra ancillary data, inherited-fd sender, truncation, open
   write half or second packet before journal access.
7. Persist one exact untrusted candidate tuple before approval. Approval additionally requires a
   non-serializable `RootVerifiedPreparedEnvelope` that independently binds the complete envelope,
   evidence, four external-window/pre-apply observation instants and root pins, plus
   `FreshAttendedAuthentication` bound to an opcode-specific challenge. The wire can mint neither;
   only `cfg(test)` fakes exist in WP-199. The operator request carries only the exact candidate CAS
   identity and derived challenge. Registration refuses an envelope expiry beyond `now + 900s`.
8. Independently construct, encode, sign and verify the exact WP-197 approval-grant and execution-
   ticket leaves and signature domains. Use one trusted-clock sample per locked mutation and the
   exact freshness/minimum-expiry derivations from the architecture; ticket expiry equals grant
   expiry, external-window expiry retains exact milliseconds and all four verified observations must
   be strictly younger than 60 seconds. Do not import or call WP-198 in privileged Rust code.
9. Persist exactly these edges: `empty_or_terminal -> candidate_registered -> approved -> consumed`,
   plus attended strictly-expired-without-successor closures for candidate or approved state.
10. Treat expired closures as private journal classifications only. Never create or imply WP-197
    `terminal_no_spawn`, zero-resource, launcher, session or migration evidence.
11. Bind every nonterminal transition to one internally generated authority incarnation. After
    restart, a valid nonterminal state is recovery-only; only root digest status for later read-only
    reconciliation and an exact attended expired-without-successor closure remain possible. There is
    no root reconcile opcode. That closure binds both the original operation and current closing
    authority incarnations and is the only recovery signing exception; they are equal for a live
    same-process closure and differ after recovery.
12. Enforce one nonterminal operation per supplied locked journal and permanent uniqueness of
    operation ids, authorization nonces, authentication sessions, envelope digests, incarnation
    digests and ticket nonces. Leave proof that this journal is host-global to WP-203.
13. Use a singleton journal lock and exact compare-and-set over generation, prior digest/state,
    operation, authorization and artifact digests. Combine the whole-file lifetime OFD lock for
    cross-process exclusion with a private non-cloneable in-process mutation mutex held through the
    response-attempt state change. Concurrent thread or process mutations have one winner.
14. Accept only a pre-opened state-directory descriptor inside the test-only composition. Enforce
    the exact `FORMAT`, genesis and fixed tree plus the fd-relative `LOCK` inode, nonblocking Linux
    OFD lifetime lock, ownership, modes, link counts, local-filesystem and
    no-symlink/no-mount-crossing rules without accepting a path.
15. Use immutable content-addressed leaf/signature objects and immutable generation-numbered signed
    transitions with the architecture's exact schemas, domains and full-record digest rules. Publish
    each at its final name with exclusive creation, full write, metadata verification, file sync and
    directory sync. Publish/sync the raw transition signature before its transition; respond only
    after the transition-directory sync succeeds.
16. Use no mutable `HEAD`. Inventory and verify the complete chain on open and before every
    mutation. Corruption, gaps, forks, unknown final files, orphan or unreferenced objects,
    permission drift, impossible edges, clock rollback or uncertain durability enter recovery-only.
    Enforce the fixed format-v1 inventory caps of 4,096 transitions, 12,288 leaves, 16,384 signatures
    and 64 MiB total content before allocation.
17. Never auto-repair, truncate, delete, overwrite, clean, choose a fork, roll back, reset or reuse a
    generation. Maintenance is outside WP-199.
18. Sign only through crate-private non-cloneable record-specific methods. Expose no arbitrary
    signing domain, composition trait, production key import/loading or key generation. Tests use
    synthetic in-memory keys only, and the verifier compares every issuer digest to an opaque
    external root pin before signature verification.
19. Draw exactly one ticket nonce for the one winning consume. A collision or entropy failure
    refuses without another draw in that request.
20. Return the ticket bytes/signature only from the winning consume response after durability. A
    replay, concurrent loser, lost response, partial response or restart never remints or redelivers
    a ticket. Status returns digests only.
21. Return only fixed nonsensitive success/refusal shapes and never echo private input, target,
    operator, signature, path or exception details. The sole exception is the successful private
    consume response, which returns one ticket/signature once. Rust and the WP-198 TypeScript oracle
    must consume the same checked-in immutable golden corpus.
    Both closure transitions persist the action challenge and fresh operator/session/time evidence,
    and permanent session uniqueness covers approval and both closure paths.
22. Keep all production composition absent: no real socket creation, pathname, uid/gid policy,
    PAM/TTY integration, key handle, root directory provisioning, listener loop, child process,
    service or deployment file.
23. Pin Rust `1.97.1` and the complete Cargo graph. The package test wrapper must accept only no
    forwarded argument or the repository CI's exact `--maxWorkers=1`, consume that known argument,
    and run locked Cargo plus Vitest checks. When local Cargo is absent, use only this official image:

    ```text
    docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
    ```

## Proof requirements

- golden canonical bytes and signatures for grants, tickets and every internal transition;
- test-only WP-198 agreement for Rust-generated grant/ticket vectors;
- mutation of every signed field, domain, key, signature and repeated binding refuses;
- candidate-binding/challenge construction, per-opcode closure challenges and cross-operation
  authentication-session replay refuse, including after restart;
- registration at exactly 900 seconds passes and 901 refuses; mixed-precision equal minima use the
  fixed precedence; advancing time alone never closes or releases the candidate;
- for each of the four private observation instants independently: age 59 seconds with the other
  three fresh passes, age 60 refuses and a future instant refuses;
- complete legal/illegal transition table and cross-operation/nonce/target/envelope/window/key replay
  matrix;
- N-way threaded and cross-process registration/approval/consume proves one chain successor and one
  ticket;
- deterministic fault cuts around every write/sync/publication/response boundary reopen to the old
  complete state, conservative new state or recovery-only, never rollback after capability escape;
- process-kill/restart cases cover clean, candidate, approved, consumed and corrupt journals;
- lost/partial approval and ticket responses prove no second signature, nonce or ticket delivery;
- every filename, content, chain, object, permission, ownership, link, symlink, mount and
  orphan/unreferenced-object corruption case fails closed;
- wrong peer/surface/socket/message/version/length/hash/schema, inherited-fd sender, oversize,
  truncation, open write half, trailing/second packet and ancillary-data cases refuse before
  mutation;
- privacy canaries cannot enter responses, logs, public results or nested error text;
- static Cargo metadata, rustdoc, source/package and reverse-dependency inventory proves no public
  callable API, binary, example, benchmark, listener, arbitrary path/sign, environment, process,
  network, database, Supabase, credential, service-manager, deployment or live-target capability in
  production Rust modules; test wrappers are separately limited to the pinned toolchain and Vitest;
- pinned Cargo format/clippy/check/test and TypeScript tests pass through the ordinary workspace;
- repository typecheck, lint, test, hygiene, skill-lint and full exact-head/exact-main CI pass;
- one independent High correctness review and two Extra-High crash/authority reviews close before
  merge.

## Explicit exclusions

WP-199 does not:

- authenticate a real human, create or listen on a real socket, provision a root directory or load a
  production signing key;
- give the production Rust library process-spawn capability or launch an authority, CLI or migration
  child; test-only wrappers may spawn the pinned compiler, Vitest, container and crash/race harness;
- connect to a project, use a credential, query hosted history, dry-run or apply a migration;
- stage, install, activate, stop, start or deploy a service;
- create `executing`, `terminal` or `terminal_no_spawn` evidence;
- expose any operation to T3/Codex or the guarded broker;
- update handover/status before reviewed merge and exact-main CI.

## Ordered handoff

WP-199 merged through PR #129 at `b0a6b0c262c3c4611836014aa780f0ade2609b0f` after exact-head
run `33762823607` passed both jobs at `962085507256b95edc51a64c03554112dc945410` and exact-main
run `33764232345` passed both jobs at the merge revision. All 86 focused Rust tests, 12 TypeScript
boundary tests, full repository checks and 11 serial browser suites passed. Independent High
correctness and two Extra-High authority, crash and reliability reviews ended with no finding after
corrections.

Continue with WP-200's attended official CLI provenance plus disposable synthetic launcher proofs.
Every external action remains separately and exactly gated.
