# WP-198 — Hosted migration conformance oracle

Owner: pure hosted-migration supervisor record verification and lifecycle reduction.

Depends on: merged WP-197 corrected closeout and exact-main CI at
`61b56774142d74ace6be861b4a3b58acee991d7d`.

Architecture: `docs/design/WP-198-ARCHITECTURE.md`.

## Objective

Implement a source-only TypeScript package that verifies canonical signed supervisor records,
deterministic phase tags, runtime-attestation chains, cross-record bindings and legal preparation or
apply lifecycle transcripts.

The package is an inert conformance oracle. It does not authorize, sign, generate identity, inspect
live state, connect, spawn, deploy or apply. Its only terminal vocabulary is `conformant` and
`refused`.

## Owned files

- WP-198 architecture and this work-package brief;
- new `tools/hosted-migration-conformance` package and focused tests;
- root lockfile entry or workspace test command only if required to run the new package.

Do not edit `packages/shared`, existing packages, applications, migrations, Supabase configuration,
deployment scripts, service units, CI workflows, handover or status during implementation. Handover
and status change only after reviewed merge and exact-main CI.

## Required behavior

1. Export pure library functions only. Publish no CLI or `bin` entry.
2. Accept only bytes and bounded record/transcript values. Accept no path, project reference,
   database URL, hostname, command, flag, environment map, credential or callback.
3. Parse the eight exact standalone WP-197 signed-leaf schemas with their original `schemaVersion`
   names and key order. Use UTF-8 canonical JSON with two-space indentation and one terminal line
   feed. Refuse invalid UTF-8, duplicate, missing, extra or reordered keys, alternate whitespace,
   noncanonical escaping, wrong types and values outside exact scalar constraints.
4. Do not invent a wrapper or rename fields. The complete leaf ends with
   `detachedSignatureSha256`; the separately supplied raw signature remains outside JSON. Unknown
   records and generic extension fields are refused.
5. Verify Ed25519 over the exact domain-separated canonical unsigned leaf through
   `issuerPublicKeySha256`. Validate raw public-key and raw-signature encodings, require both the
   issuer-key digest and final detached-signature digest to match, and never expose signing,
   key-generation or random APIs.
6. Derive exact 61-character operation-private phase tags for `history_fetch`, `dry_run` and `apply`.
   Never create operation ids or authorization nonces.
7. Fold the runtime-attestation chain using the exact null-terminated domain, one-based big-endian
   `execOrdinal`, previous raw digest and raw complete-signed-leaf digest. Enforce zero genesis and
   contiguous ordinals starting at one. Pin the official front-controller and delegate paths and
   public payload hashes. Refuse self-parenting, duplicate or cyclic process identities. Bind the
   complete
   one- or two-leaf graph in both terminal prefix and final chain/count pairs.
8. Reduce only the legal preparation and apply paths. Refuse duplicate, skipped, reordered,
   cross-operation, cross-nonce, cross-target/window where present, cross-phase or cross-authorization
   evidence.
9. Permit `terminal_no_spawn` only from `prepared` for preparation or `consumed` for apply and only
   with a valid signed no-execution record whose namespace, cgroup, child, pidfd and exact tagged-
   session counts are all zero.
10. Require a terminal graph to follow at least one valid runtime attestation, bind its exact prefix
    and final chain/counts and close the same authorization, operation, nonce and phase. Do not
    synthesize target or generation fields into leaves where WP-197 does not define them. Require one
    stable launcher signer across runtime and terminal leaves and require it to differ from the root
    ticket/grant authority. Refuse runtime evidence before issue/consumption or whose first
    observation is at or after expiry, and require expiry-specific no-spawn reasons to be observed at or
    after expiry.
11. Close exact preparation-ticket/no-execution/attestation/terminal bindings and exact approval-
    grant/execution-ticket/no-execution/attestation/terminal bindings. Preparation tickets cannot
    name apply or write capability; apply cannot use a preparation ticket. Do not expose a complete-
    operation aggregate until the canonical WP-197 operation envelope and all referenced evidence
    leaves are themselves inputs and verified; matching an arbitrary repeated envelope digest is not
    sufficient.
12. Return only bounded `conformant` results or fixed nonsensitive refusal codes. Never return or
    imply `authorized`, `approved`, `safe_to_apply`, `held`, `fresh`, `target_verified` or `applied`.
    Never echo input bytes, values, key material, signatures or nested exception text on failure.
    Freeze both success and refusal results. Contain unexpected stateful-input exceptions at every
    public verifier boundary. Lifecycle summaries use neutral evidence-presence labels, not private
    journal state claims.
13. Use only deterministic UTF-8 handling, SHA-256 and Ed25519 verification. Static proof must deny
    filesystem, path-input, process-spawn, network, database, Supabase, browser, secret-manager,
    service-manager, environment, signing, key-generation, randomness, dynamic import/evaluation and
    native-addon capability.
14. Document in exported API comments and package README that public conformance is not live evidence
    or authorization and must not be a production spawn gate.

## Proof requirements

- golden byte fixtures close canonical JSON and every signature domain;
- invalid UTF-8, duplicate/extra/missing/reordered keys, whitespace, escaping, type and control
  mutations refuse;
- valid Ed25519 fixtures verify and mutation of every signed field, key and signature refuses;
  fields admitting a schema-valid one-field alternative have fresh-valid controls, while singleton
  fields prove structural refusal;
- session-tag golden vectors and malformed input cases close;
- raw-byte chain golden vectors differ from hex-text concatenation and refuse every reorder,
  deletion, duplicate, substitution, ordinal gap and splice;
- the complete legal transition table passes and every omitted or ambiguous edge is refused without
  reset, retry, recovery or another authoritative state claim;
- no-spawn records require exact zero resource and tagged-session facts;
- cross-binding/replay cases cover operation, target, generation, nonce, phase, ticket/grant and
  envelope digests;
- prototype-independent canonical serialization, immutable input snapshots, contained throwing
  inputs and frozen scalar-only public structured results close stateful input/output attacks;
- the exact front-controller/delegate topology, stable launcher issuer across runtime and terminal
  leaves and a launcher key distinct from the root authority close execution-authority boundaries;
- exact leaf-count and aggregate-byte limits refuse before cryptographic work;
- privacy-canary and fuzz-style malformed inputs cannot enter result values;
- an exact static source/module/package inventory closes imports, re-exports, APIs, package metadata,
  runtime dependencies and absence of CLI reachability;
- the public surface has no whole-operation aggregate until its exact operational envelope and all
  referenced evidence leaves are inputs;
- focused tests, package typecheck/lint, repository hygiene, full repository CI and exact-head PR CI
  pass;
- one independent High correctness review and Extra-High adversarial safety reviews close before
  merge.

## Explicit exclusions

WP-198 does not:

- query, fetch, dry-run, repair or apply a hosted migration;
- use the WP-197 bundle as a CLI work directory;
- sign a record, generate a key/id/nonce or read a clock;
- inspect a project, credential, process, executable, cgroup, session, lock, queue or freeze;
- create a journal, socket, service, namespace, child process or deployment artifact;
- expose a copy-paste production command or change deployed revisions;
- update the live status or handover before this slice is merged and exact-main CI is green.

## Ordered handoff

After merge and exact-main CI, reconcile and update `docs/HANDOVER.md` and `docs/STATUS.md`, then
continue with WP-199's deployment-private root journal and fixed IPC design. Actual target connection,
CLI launch and apply remain progressively gated through WP-205 as described in the architecture.
