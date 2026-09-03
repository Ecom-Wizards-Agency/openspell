# WP-198 architecture: hosted migration conformance oracle

Status: selected for implementation on 2026-09-03.

Base: `origin/main` at `61b56774142d74ace6be861b4a3b58acee991d7d`.

## Outcome

WP-198 adds a small public TypeScript package that can answer one question about supplied migration
supervisor evidence: does it conform to the reviewed byte, signature, binding, chain and lifecycle
contract?

The only terminal results are `conformant` and `refused`. A conformant result is not evidence that a
record is current, that a target was inspected, that an operator approved an action or that an apply
is safe. The package is a deterministic test oracle for records produced elsewhere. It never creates
authority or reaches external state.

## Reconciled starting point

The implementation starts after the corrected WP-197 closeout merged at the base revision above.
Exact-main CI is green and there are no open pull requests. A fresh read-only hosted ledger query on
2026-09-03 closed 41 matching local/remote versions through `20260901010000`; none of the five
reviewed suffix migrations through `20260901060000` was applied by that check.

The source-only WP-197 bundle is complete. Its exact 46-file output contract, reviewed Supabase CLI
2.116.0 provenance, six prefix-specific read-only evidence scripts and future private-supervisor
requirements are inputs to this design. WP-198 does not alter or invoke that tool.

The live web revision observed during reconciliation was
`44da7ac32e5a0503993e567c41aaccffd5c39b06`; the live MCP revision was
`b5c210dca2c28576180223dbe853e61ae7092e73`. The legacy worker was running without a revision stamp,
and neither OpenSpell worker unit was installed. Those deployment facts are intentionally outside
the conformance result.

## Critical safety fact

A verifier in the public repository cannot prove possession of production authority, root custody,
fresh target state, a held lock, a frozen enqueue path, credential scope, process isolation or
restricted egress. Treating its output as an apply decision would turn attacker-controlled evidence
into authorization.

Consequently, no production launcher or private supervisor may use this package's result as its sole
or final spawn gate. The future root authority must independently validate signed records, consume
one-use authority with durable compare-and-set semantics and remeasure live state immediately before
creating an execution resource.

## Architecture candidates

### Candidate A: one privileged TypeScript orchestrator

Put record validation, credentials, Supabase invocation, locking and root launch in one process.

Decision: rejected. A parser or state-machine defect would share an authority boundary with secrets
and production execution.

### Candidate B: unprivileged TypeScript calling `systemd-run`

Keep most policy in TypeScript and cross privilege through a generic system service interface.

Decision: rejected. A generic launcher exposes argv, environment, executable and service-property
channels that are much broader than the one reviewed migration protocol.

### Candidate C: pure public oracle plus later minimal private authorities

Keep the public package limited to canonical parsing, Ed25519 verification, deterministic derivation,
cross-binding and transition reduction. In later work, place live coordination in an unprivileged,
deployment-private supervisor, attended approval in a separate root control path and launch/one-use
journaling in a minimal fixed-protocol root authority.

Decision: selected. WP-198 implements only the pure public oracle.

## Trust and authority boundaries

| Component | May hold or do | Must not claim or do |
|---|---|---|
| WP-198 public oracle | Parse canonical bytes, hash, verify Ed25519 signatures, compare bindings, reduce supplied state | Freshness, approval, target access, filesystem access, signing, spawn, apply |
| Future private coordinator | Prepare a fixed operation, report status, reconcile ambiguous outcomes | Root signing key, generic execution, accepting caller-selected target/argv/env |
| Future root authority | Hold signing key and journal, consume one-use grants, enforce fixed launch protocol | Provider credential, caller-defined execution, agent-accessible approval |
| Future attended root control | Authenticate operator and issue one exact expiring approval | Background or agent-driven approval |
| Supabase CLI child | Execute one fixed phase against one fixed target under measured isolation | Choose policy, target, migration bytes, credentials or retry behavior |

The public oracle pins public release facts and record semantics. Production trust roots, private
target fingerprints, credentials, journals, sockets, executable images and service policies remain
deployment-private and root-owned.

## WP-198 package boundary

The new package is `@wizard-ads/hosted-migration-conformance` at
`tools/hosted-migration-conformance`. It has no `bin` entry and exports pure functions only. Inputs
are byte arrays, already-parsed scalar values or bounded record arrays. It accepts no path, project
reference, database URL, hostname, command, flag, environment map, credential or callback.

Allowed implementation capabilities are deterministic UTF-8 decoding, SHA-256 hashing and Ed25519
signature verification from `node:crypto`. The source may not import filesystem, process-control,
network, DNS, TLS, HTTP, database, Supabase, browser, secret-manager or service-manager modules. It
may not call signing, key-generation, random-generation, dynamic-import, evaluation or native-addon
APIs.

The package owns no application, migration, deployment or shared-contract file. It does not modify
`packages/shared`, `packages/db`, `apps/*`, `supabase/*`, `docs/deploy/*`, CI workflow files, systemd
units or the WP-197 package.

## Result vocabulary

Every high-level check returns one of these discriminated values:

```ts
type ConformanceResult<T> =
  | { readonly status: "conformant"; readonly value: T }
  | { readonly status: "refused"; readonly code: RefusalCode };
```

Refusal codes are fixed, nonsensitive identifiers. Failures never echo input bytes, field values,
keys, signatures, target data or lower-level exception messages. The API never returns `authorized`,
`approved`, `safe_to_apply`, `held`, `fresh`, `target_verified` or `applied`.

Lifecycle summaries use evidence-presence labels only: `grant_only`, `preparation_ticket_only`,
`execution_ticket_only`, `terminal_graph_present`, `terminal_no_spawn_result_present` and
`incomplete_execution_evidence`. They do not repeat the authoritative private journal state names.
Both success and refusal envelopes are frozen. Every public verifier contains stateful input access
and converts unexpected input exceptions into a fixed nonsensitive refusal.

## Canonical JSON contract

Every signed leaf is the exact standalone object already specified by WP-197, with its original
`schemaVersion` and key order. Canonical JSON is UTF-8 without a byte
order mark, two-space indentation and exactly one terminal line feed. Object keys appear in the
schema order; arrays preserve their declared order. Unknown and missing keys, duplicate keys,
noncanonical escaping, invalid UTF-8, alternate whitespace and values outside the exact scalar
contract are refused.

The signature preimage is:

```text
<leaf-domain>\n<canonical unsigned-leaf JSON, including its one terminal LF>
```

There is no blank line between the domain and JSON and no second line feed after the canonical JSON.
Signatures are Ed25519 over those exact bytes. Public keys are raw 32-byte lowercase hex; signatures
are raw 64-byte lowercase hex supplied separately from the leaf, as WP-197 requires for the
root-retained signature store. `issuerPublicKeySha256` is lowercase SHA-256 of the raw public-key
bytes and must match the supplied verification key. The complete leaf's final
`detachedSignatureSha256` field must equal SHA-256 of the supplied raw signature. The unsigned leaf
is the same object through `issuerPublicKeySha256`, without the final signature-digest field. The
complete-leaf digest is SHA-256 of the exact canonical standalone JSON including
`detachedSignatureSha256`; there is no `{record, signature}` wrapper.

## Exact public record families

WP-198 recognizes these versioned families and no generic extension bag:

1. `openspell.hosted-migration-external-window.v1`: the exact held window leaf at WP-197 lines
   728–749, including the fixed four-entry excluded-actor array, target generation and detached
   signature digest;
2. `openspell.hosted-migration-preparation-ticket.v1`: the exact prepared `history_fetch` or
   `dry_run` ticket at lines 936–957, including its ticket nonce, invocation/runtime/policy tuple and
   `writeCapability:false`;
3. `openspell.hosted-migration-preparation-no-execution-result.v1`: the exact zero-resource result at
   lines 973–998 with its bounded reason code and `prepared` to `terminal_no_spawn` facts;
4. `openspell.hosted-migration-runtime-attestation.v1`: the exact post-exec leaf at lines 1027–1063,
   including process identities, measured executable/maps/namespace/process protections, empty
   capability arrays and one-based `execOrdinal`;
5. `openspell.hosted-migration-terminal-exec-graph.v1`: the exact closed graph at lines 1088–1108,
   including bound and terminal chain/count pairs, empty child cgroup and zero tagged sessions;
6. `openspell.hosted-migration-approval-grant.v1`: the exact attended `approved` grant at lines
   1284–1308, including the complete target/window/runtime/policy/invocation tuple and OS-authentication
   evidence;
7. `openspell.hosted-migration-execution-ticket.v1`: the exact root-consumed ticket at lines
   1324–1348, including the grant and grant-signature digests, new ticket nonce and repeated tuple;
8. `openspell.hosted-migration-no-execution-result.v1`: the exact apply zero-resource result at lines
   1369–1395 with its bounded reason code and `consumed` to `terminal_no_spawn` facts.

All digests and nonces are lowercase 64-hex values. Operation ids and authorization nonces are
lowercase 64-hex values, but the oracle only validates their representation and equality; it never
creates them. Numeric generations, ordinals, pids, ids and counts are safe canonical JSON integers
within their specified positive or zero bounds. The oracle validates timestamp representation and
record-relative ordering where WP-197 defines it, but does not read a clock or certify freshness.
External-window acquisition and expiry use UTC RFC 3339 with exactly milliseconds and `Z`.

## Deterministic derivations

### Phase session tags

The exact tag is `os-wp197-cli-` followed by the first 48 lowercase hex characters of SHA-256 over:

```text
openspell.hosted-migration-session.v1\n
<operation-id>\n
<authorization-nonce>\n
<phase>\n
```

Allowed phases are `history_fetch`, `dry_run` and `apply`. The result is exactly 61 ASCII characters.

### Runtime attestation chain

The genesis is 32 zero bytes. Leaf ordinals start at one and are contiguous. For each canonical
complete signed runtime-attestation leaf, the new raw 32-byte SHA-256 is calculated over:

```text
UTF8("openspell.hosted-migration-runtime-attestation-chain.v1\0")
UINT32_BE(ordinal)
previous raw 32-byte chain value
SHA256(canonical complete signed leaf bytes) as raw 32 bytes
```

The runtime-attestation leaf has no previous or resulting chain field. The fold carries the previous
raw value internally and returns the resulting value. The only accepted graph is the official front
controller `usr/local/libexec/supabase` with SHA-256
`3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4`, optionally followed by its
direct non-self-parenting, non-cyclic delegate `usr/local/libexec/supabase-go` with SHA-256
`1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1`. The terminal graph binds the
complete one- or two-leaf graph in both prefix and final chain/count pairs. Hex-text concatenation is
not equivalent and is refused by golden tests.

## Lifecycle reduction

The oracle recognizes only these paths:

```text
preparation: initial -> prepared -> executing -> terminal
                                  \-> terminal_no_spawn

apply:       initial -> approved -> consumed -> executing -> terminal
                                           \-> terminal_no_spawn
```

`terminal_no_spawn` is legal only when its exact signed no-execution result closes the applicable
ticket and every transition/resource/session count is zero. A terminal graph is legal only after at
least one valid runtime attestation, must bind its exact chain prefix and final chain/counts, and must
close the same phase authorization. Runtime evidence begins no earlier than ticket issuance or
consumption, and its first observation is strictly before ticket expiry. An expiry-specific no-spawn
reason is observed only at or after expiry. The stable runtime/terminal launcher signer differs from
the root authority signer used for the ticket or grant. Duplicate, skipped, reordered,
cross-operation, cross-target, cross-window, cross-nonce, cross-phase or cross-authorization evidence
is refused. Fields absent from a WP-197 leaf are not synthesized: for example, preparation tickets
have no target generation and runtime attestations have no target fingerprint.

Any impossible or ambiguous evidence is refused; no result label represents reset, retry, replay,
abandonment, recovery or a new generation. Because reduction examines supplied leaves, even a
conformant terminal transcript is not a live-state assertion.

## Phase transcript checks

Phase verification additionally requires:

- each preparation result, attestation and terminal graph to bind the exact complete preparation
  ticket digest and repeated WP-197 fields;
- an approval grant and execution ticket to bind the same operational-envelope digest and exact
  repeated operation, target, window, provenance, runtime, sandbox, topology, cgroup and invocation
  tuple;
- apply evidence to use only the execution ticket, never a preparation ticket;
- preparation evidence never to name `apply` or claim write capability;
- authorization digests, one-based attestation chains and terminal prefix/final counts to match
  exactly;
- no record or transcript field to be treated as proof of live freshness, target ownership, held
  locks, freeze state, credential scope or OS isolation.

WP-198 intentionally exposes no complete-operation aggregate result. WP-197's approval grant binds
the digest of the large canonical operation envelope at its lines 1205–1250. Accepting two leaves
that merely repeat an arbitrary matching envelope digest would not verify that envelope. Adding the
operation envelope and all referenced evidence leaves is later coordinator work; until then, callers
compose no `history + dry-run + apply` conformance claim from this package.

## Proof strategy

Focused tests must prove:

- exact canonical bytes, including key order, indentation and one terminal line feed;
- refusal of invalid UTF-8, duplicate/extra/missing/reordered keys, alternate whitespace, changed
  escaping, wrong types and disallowed control characters;
- valid Ed25519 verification from separately supplied raw signatures; exact
  `issuerPublicKeySha256` and `detachedSignatureSha256`; and refusal after mutation of every unsigned
  field, complete-leaf signature digest, raw signature or key, with fresh-valid controls for fields
  admitting a schema-valid one-field alternative and structural refusal for singleton fields;
- domain separation across every record family;
- prototype-independent canonical serialization, immutable input snapshots and frozen scalar-only
  public structured results;
- exact phase-tag derivation and refusal of malformed ids, nonces and phases;
- runtime-chain golden vectors use raw bytes, enforce one-based ordinal continuity and refuse leaf reorder,
  deletion, duplication, substitution or cross-chain splicing;
- the exact one- or two-binary front-controller/delegate topology, a stable launcher issuer across
  runtime and terminal leaves, and a separately keyed launcher distinct from the root authority;
- transcript leaf-count and aggregate-byte limits take effect before cryptographic verification;
- every legal preparation/apply path and every illegal transition, including no-spawn zero facts;
- cross-binding and replay resistance across operations, targets, generations, nonces, phases and
  authorization digests;
- privacy canaries never appear in returned refusal values;
- an exact static source/module/package inventory denies banned imports and APIs, signing, key
  generation, randomness, dynamic code, native addons, runtime dependencies, unlisted imports or
  re-exports and a `bin` entry;
- no whole-operation aggregate API exists without the exact WP-197 operational envelope and all
  evidence leaves it references;
- the package typechecks, lints and passes repository hygiene and full CI.

## Phased continuation

WP-198 is the first implementation slice of the private-supervisor plan:

- WP-199: private root journal, fixed IPC, separate approval/supervisor sockets and one-use
  grant/ticket compare-and-set, still with no launcher or network;
- WP-200: attended official CLI acquisition/provenance plus synthetic-binary proofs for namespaces,
  cgroups, pidfds, ptrace/exec-map attestation and process protections;
- WP-201: disposable target-scoped credential, target-only egress, hosted history and dry preparation,
  with apply absent;
- WP-202: disposable apply, two-stage database lock handoff, crash/lost-response reconciliation and
  every valid hosted prefix from 41 through 46;
- WP-203: immutable deployment artifact, stage, activate, rollback and verify for disabled units;
- WP-204: separately authorized production prerequisite provisioning, read-only history/dry run,
  operation window and enqueue freeze;
- WP-205: separately and exactly authorized production apply, postflight and recovery.

The agent-safe future coordinator API remains only `prepare()`, `status(operationId)` and
`reconcile(operationId)`. It never accepts apply, approval, target, path, argv, environment,
credential, URL, SQL or retry parameters.

## Production no-go gates

No production apply becomes available until disposable proofs establish all of the following:

- a Supabase credential scoped to the exact target and minimum exact CLI 2.116.0 operations works
  without a broad fallback;
- the measured official front-controller/delegate execution graph is exact for every phase;
- every database connection carries the complete operation-private phase tag and leaves no matching
  session after terminal exit;
- the two-stage relation/advisory-lock handoff topology and one-second bound are proven for the exact
  CLI;
- root custody, one-use journaling, cgroup containment, non-dumpability, ptrace/exec-map observation,
  syscall policy and target-only egress fail closed;
- crash, lost-response and every contiguous 41-to-46 prefix reconcile without replay or blind retry;
- exact operator authorization is given in the task that performs the production action.

Supabase documents project-scoped personal access tokens as a public-alpha capability, but the exact
minimum permission set and availability for this account remain facts to prove against a disposable
target. Classic or broad service credentials are not an acceptable fallback.

References:

- <https://supabase.com/docs/guides/platform/personal-access-tokens>
- <https://supabase.com/docs/guides/platform/access-control>
- <https://supabase.com/docs/reference/cli/supabase-db-push>
