# WP-199 architecture: private root journal and fixed IPC

Status: selected for implementation on 2026-09-03.

Base: `origin/main` at `b61da3a121651c059260c8a28e1d4e5bdf6500bd`.

## Outcome

WP-199 adds an offline, source-only native library and test harness for the future hosted-migration
root authority. It proves four things within one supplied, locked journal without creating a
runnable authority:

- one immutable, hash-chained root journal has a single legal successor at each generation;
- an exact prepared operation can become one exact signed approval grant and then one exact signed
  execution ticket through durable compare-and-set transitions;
- operator approval and supervisor consumption use separate fixed protocol surfaces;
- crashes, corruption, replay and lost responses fail closed without rollback or reminting.

WP-199 has no installed binary, listener, socket pathname, production key loader, launcher, target
credential, network, database, Supabase invocation, deployment artifact or live-host action. It does
not make the root authority usable in production.

## Reconciled starting point

WP-198 and its closeout are merged at the base revision. PR #127 and PR #128 passed exact-head and
exact-main CI, and there are no open pull requests. The hosted ledger remains at 41 versions through
`20260901010000`; the five reviewed suffix migrations remain source-only. Production web remains at
`44da7ac`, production MCP remains at `b5c210d`, the two new worker units remain absent and the active
legacy worker revision remains unproven.

The merged WP-198 oracle verifies supplied signed leaves and transcripts but deliberately cannot
create authority or prove live state. WP-199 independently implements the privileged grant/ticket
record rules. WP-198 is a test oracle only and is never a runtime dependency or authority decision.

## Safety fact

A correct journal transition is not operator authentication, target verification or permission to
spawn. A fixed protocol parser is not a trusted peer boundary until a later deployment supplies and
proves the pre-opened sockets, peer policy, filesystem, key handle and process sandbox.

Therefore every WP-199 success is source-level evidence only. Later packages must independently
prove real peer credentials, fresh attended authentication, root ownership, storage behavior, key
custody, launcher isolation, target scope and exact deployment policy before any production use.

## Architecture candidates

### Candidate A: privileged TypeScript service

Use Node for the journal, Unix listeners and signing because the repository already uses pnpm,
Turbo and Vitest.

Decision: rejected for the root authority. Node supports pathname Unix sockets but does not expose
the Linux peer-credential and fd-relative filesystem primitives required by this boundary. Treating
socket permissions as caller authentication would weaken the signed WP-197 contract.

### Candidate B: complete native daemon now

Add a native binary, socket creation, root filesystem layout, production signer and service units in
one package.

Decision: rejected for WP-199. It would combine source semantics with deployment and live-host
authority before disposable launcher, filesystem and credential proofs exist.

### Candidate C: source-only native library plus injected-handle harness

Implement strict records, reducers, journal storage, peer checks and per-surface dispatch over
already-open authenticated handles. Publish a Rust library and tests, but no binary or installer.
Wrap it in a private `tools/*` pnpm package so existing Turbo CI discovers its checks.

Decision: selected. Rust is memory-safe, and a pinned safe `rustix` wrapper supplies Linux
peer-message credentials, `recvmsg`, fd-relative filesystem calls and OFD locking without unsafe
code in this crate. The target is Linux only. The toolchain is pinned; Cargo dependencies are
locked; the crate forbids unsafe code. GitHub's current Ubuntu 24.04 runner image includes Rust,
Cargo, rustfmt and clippy. Local verification may use a disposable official Rust container rather
than installing authority tooling on the host.

## Three-channel system boundary

The complete future system has three channels. WP-198 already owns the broker-facing vocabulary;
WP-199 treats that channel as a contextual constraint and defines only the two root-authority wire
families over injected handles.

1. **Broker to supervisor.** The guarded broker may request only `prepare`, `status(operationId)`
   and read-only `reconcile(operationId)`. General agent identities never connect directly. The
   request cannot contain a target, phase, apply flag, path, command, environment, credential, URL,
   SQL or retry control. The live supervisor listener is not part of WP-199.
2. **Supervisor to root authority.** One dedicated supervisor identity may register one exact
   prepared candidate, read digest-only root state and request the `approved -> consumed`
   transition. It cannot approve, sign arbitrary bytes, select root policy, launch or reset.
3. **Attended helper to root authority.** A separate root/operator identity may approve only the
   exact already-registered candidate or close a strictly expired unconsumed candidate/grant. It
   cannot prepare, consume, launch or choose another target.

Collapsing these into two whole-system channels is a blocker: it would expose either approval or
ticket consumption through the agent-facing surface. The two root-authority endpoints also use
separate decoders and handlers; there is no generic role or method dispatcher.

Both root surfaces require an already-connected Linux `AF_UNIX/SOCK_SEQPACKET` handle. The receiver
enables `SO_PASSCRED`, checks `SO_DOMAIN`, `SO_TYPE`, connected/non-listening state and connection
`SO_PEERCRED`, and requires exactly one kernel `SCM_CREDENTIALS` record on the request. The per-message
pid/uid/gid must equal both the immutable synthetic peer policy and the connection peer; any
`SCM_RIGHTS` or extra control record refuses before journal access. This rejects a child that sends
through an inherited connection whose original peer pid differs.

These checks prove only the implementation seam. They do not prove production caller identity or
fresh attended authentication. PID reuse, process start identity, cgroup/executable binding,
pidfds, PAM/TTY/audit binding and real socket ownership remain later deployment gates.

## Fixed wire protocol

Each connection carries one request record and at most one response record. Streams and datagrams
are refused. Before sending, the client must send one complete sequenced-packet record and then
`shutdown(SHUT_WR)`. The authority receives with `recvmsg`, refuses `MSG_TRUNC`, and performs a
second receive that must return EOF before journal access. A second record, an open write half or
any ancillary-data mismatch refuses. The frame is exact:

```text
8 bytes   magic = OSWP199\0
2 bytes   unsigned big-endian version = 1
2 bytes   unsigned big-endian message type
4 bytes   unsigned big-endian payload length
32 bytes  raw SHA-256 of payload
N bytes   exact canonical payload
```

The maximum complete record, including the 48-byte header, is 16 KiB. Each message type has one
exact, separately decoded canonical JSON schema with fixed key order and no optional, unknown or
extension fields. Identifiers, fingerprints and SHA-256 values are exactly 64 lowercase hexadecimal
characters; raw signatures are 128 lowercase hexadecimal characters. Envelope, authentication,
`issuedAt`, `consumedAt`, `storedAt` and `trustedAt` timestamps are UTC RFC 3339 with whole seconds
and `Z`; `externalExclusiveWindowExpiresAt` retains the WP-197 external-window format with exactly
three fractional digits and `Z`. Derived `cutoffAt` and grant/ticket `expiresAt` preserve the exact
whole-second or three-digit precision of the selected minimum. Equal-instant minima use the first
source in this fixed order: envelope expiry, external-window expiry, authentication-plus-300s,
issue-plus-900s. Candidate cutoff uses the first two entries; ticket expiry copies the selected
grant string byte-for-byte. All timestamps are from
`2020-01-01T00:00:00Z` inclusive through
`2100-01-01T00:00:00Z` exclusive and comparisons decode exact instants without truncation or
normalization. Wire, journal and signed-leaf canonical JSON use the same exact two-space/terminal-LF
encoder defined below and every canonical object is at most 16 KiB. No generic
`Value`, negotiation, compression, streaming, pipelining or caller-selected response detail is
accepted. The payload hash detects framing corruption only; it is not authentication or authority.

The decoder refuses before state access on a wrong magic/version/type/length/hash, unknown key,
duplicate key, reordered key, noncanonical whitespace or escaping, invalid UTF-8, oversize packet,
truncation, trailing bytes, second packet, descriptor passing or other ancillary data. Unauthorized
peers receive no response bytes.

Authorized refusals contain only a fixed request-family label and one nonsensitive code. No
operator, status or refusal response and no log echoes an operation value, target fact, canonical
leaf, signature, operator identity, path or exception text. The sole exception is the successful
supervisor-private `consume` response, which returns one committed execution-ticket leaf and raw
signature once. No refusal is marked retryable.

### Opcode table

Message types are unsigned big-endian values. A success type is the request type plus `0x8000`.
Only the listed request types are valid on each surface.

| Surface | Request | Type | Success type |
|---|---|---:|---:|
| supervisor | register candidate | `0x1101` | `0x9101` |
| supervisor | status | `0x1102` | `0x9102` |
| supervisor | consume grant | `0x1103` | `0x9103` |
| attended operator | approve candidate | `0x2101` | `0xa101` |
| attended operator | close expired candidate | `0x2102` | `0xa102` |
| attended operator | close expired approval | `0x2103` | `0xa103` |

Supervisor refusals use `0x9fff`; operator refusals use `0xafff`. An unauthorized peer, wrong
socket kind/domain/state, missing or mismatched kernel credential, extra control record or descriptor
passing receives no response bytes. An authorized malformed request receives the surface-specific
refusal.

### Exact request payloads

The fields below are in mandatory canonical order. `generation` is an integer from zero through
`9_999_999_999`; `externalExclusiveWindowGeneration` is from one through `9_999_999_999`. No JSON
number outside those ranges is accepted.

- `0x1101`: `schemaVersion` =
  `openspell.hosted-migration-root-register-request.v1`, `expectedGeneration`,
  `expectedTransitionSha256`, `operationId`, `authorizationNonce`, `targetFingerprint`,
  `targetSelectionSha256`, `envelopeSha256`, `envelopeExpiresAt`,
  `externalExclusiveWindowGeneration`, `externalExclusiveWindowEvidenceSha256`,
  `externalExclusiveWindowExpiresAt`, `officialSourceEvidenceSha256`,
  `nativeRuntimeIdentitySha256`, `childSandboxPolicySha256`,
  `phaseExecTopologyPolicySha256`, `childCgroupPolicySha256`,
  `applyInvocationEvidenceSha256`.
- `0x1102`: `schemaVersion` = `openspell.hosted-migration-root-status-request.v1`,
  `operationId`.
- `0x1103`: `schemaVersion` = `openspell.hosted-migration-root-consume-request.v1`,
  `expectedGeneration`, `expectedTransitionSha256`, `operationId`, `authorizationNonce`,
  `approvalGrantSha256`, `approvalGrantSignatureSha256`.
- `0x2101`: `schemaVersion` = `openspell.hosted-migration-root-approve-request.v1`,
  `expectedGeneration`, `expectedTransitionSha256`, `operationId`, `authorizationNonce`,
  `envelopeSha256`, `actionChallengeSha256`.
- `0x2102`: `schemaVersion` =
  `openspell.hosted-migration-root-close-candidate-request.v1`, `expectedGeneration`,
  `expectedTransitionSha256`, `operationId`, `authorizationNonce`, `envelopeSha256`,
  `actionChallengeSha256`.
- `0x2103`: `schemaVersion` =
  `openspell.hosted-migration-root-close-approval-request.v1`, `expectedGeneration`,
  `expectedTransitionSha256`, `operationId`, `authorizationNonce`, `envelopeSha256`,
  `approvalGrantSha256`, `approvalGrantSignatureSha256`, `actionChallengeSha256`.

Generation zero is valid only for the first registration and requires
`expectedTransitionSha256` to equal the pinned genesis digest. A later registration names the exact
verified terminal predecessor. Registration values are explicitly untrusted input; none is signing
authority.

### Exact success and refusal payloads

Every mutating success starts with its fixed `schemaVersion`, then `status` = `committed`, followed
by the keys in the listed order:

- `0x9101`, schema `openspell.hosted-migration-root-register-success.v1`: `generation`,
  `transitionSha256`, `state` = `candidate_registered`, `candidateSha256`,
  `candidateBindingSha256`, `approvalChallengeSha256`, `cutoffAt`.
- `0x9103`, schema `openspell.hosted-migration-root-consume-success.v1`: `generation`,
  `transitionSha256`, `state` = `consumed`, `executionTicketCanonicalHex`,
  `executionTicketRawSignatureHex`. This is the only bearer response.
- `0xa101`, schema `openspell.hosted-migration-root-approve-success.v1`: `generation`,
  `transitionSha256`, `state` = `approved`, `approvalGrantSha256`,
  `approvalGrantSignatureSha256`, `expiresAt`.
- `0xa102`, schema `openspell.hosted-migration-root-close-candidate-success.v1`: `generation`,
  `transitionSha256`, `state` = `candidate_expired`.
- `0xa103`, schema `openspell.hosted-migration-root-close-approval-success.v1`: `generation`,
  `transitionSha256`, `state` = `approval_expired`.

The `0x9102` status success is one of six exact schemas. An absent operation is `schemaVersion`,
`status` = `absent` under `openspell.hosted-migration-root-status-absent.v1`. Every verified-state
schema then uses `status` = `available|recovery_only`, `generation`, `transitionSha256`, `state`,
followed by the listed state fields:

- `openspell.hosted-migration-root-status-candidate.v1`, state `candidate_registered`:
  `candidateSha256`, `candidateBindingSha256`, `approvalChallengeSha256`, `cutoffAt`;
- `openspell.hosted-migration-root-status-approved.v1`, state `approved`:
  `approvalGrantSha256`, `approvalGrantSignatureSha256`, `expiresAt`;
- `openspell.hosted-migration-root-status-consumed.v1`, state `consumed`:
  `executionTicketSha256`, `executionTicketSignatureSha256`, `expiresAt`;
- `openspell.hosted-migration-root-status-candidate-expired.v1`, state `candidate_expired`:
  `candidateSha256`;
- `openspell.hosted-migration-root-status-approval-expired.v1`, state `approval_expired`:
  `approvalGrantSha256`, `approvalGrantSignatureSha256`.

Status never returns canonical leaf bytes or a raw signature. An ambiguous or corrupt journal never
returns suffix-derived values; it refuses `journal_unavailable`.
`recovery_only` is used exactly when this process opened on a verified nonterminal operation;
otherwise the status is `available`.

Refusals are exactly `schemaVersion`, `requestFamily`, `status` = `refused`, `code`. The schema is
`openspell.hosted-migration-root-supervisor-refusal.v1` or
`openspell.hosted-migration-root-operator-refusal.v1`; `requestFamily` is exactly one of
`register_candidate`, `status`, `consume_grant`, `approve_candidate`, `close_expired_candidate` or
`close_expired_approval`, restricted to the response surface. `code` is exactly one of
`invalid_request`, `stale_compare_and_set`, `invalid_state`,
`policy_mismatch`, `expired`, `not_expired`, `recovery_only`, `journal_unavailable`,
`signer_unavailable`, `clock_invalid`, `entropy_unavailable` or `nonce_collision`. A failed or
partial response send never changes the durable result and never permits a bearer response replay.

## Untrusted candidate and private verification capabilities

The supervisor-private registration message contains the exact grant tuple already frozen by
WP-197:

- operation id and authorization nonce;
- target fingerprint and target-selection digest;
- complete operation-envelope digest and expiry;
- external-window generation, evidence digest and expiry;
- official-source, native-runtime, sandbox, exec-topology, child-cgroup and apply-invocation
  evidence digests.

Every digest and identifier uses the exact lowercase-hex encoding defined by the wire contract.
Evidence expiries are signed evidence facts, not trusted clock samples. No caller supplies
`issuedAt`, `consumedAt`, an authority incarnation or a ticket nonce.

Registration persists an `UntrustedCandidate` before returning its generation and transition
digest. It does not claim that the envelope evidence is fresh, live or correct and it cannot be
promoted by matching its own fields. Approval requires a non-serializable
`RootVerifiedPreparedEnvelope` capability. That capability binds the complete canonical envelope,
all referenced evidence, fixed target/policy pins, signed external-window/quarantine evidence and
the candidate digest. It also carries the independently verified external-window acquisition,
pre-apply target observation, pre-apply freeze observation and schema-DDL-guard second-probe
observation instants. The supervisor wire cannot construct it. WP-199 provides only a `cfg(test)`
synthetic verifier that can mint it; WP-204 must later implement and prove the private verifier over
pre-opened root evidence. The operator display projection must also derive from this verified
capability, never from supervisor fields.

Registration first canonicalizes the candidate projection with both `candidateBindingSha256` and
`approvalChallengeSha256` omitted while retaining every other field in its listed relative order.
`candidateBindingSha256` is SHA-256 of those bytes. `approvalChallengeSha256` is SHA-256 over
exactly the ASCII bytes
`openspell.hosted-migration-approval-challenge.v1\n` followed by that raw 32-byte binding digest. The
two fields are then inserted at their fixed positions and the final candidate digest is computed.
This dependency order is noncircular, binds the whole pre-challenge candidate and consumes no
entropy. The candidate cutoff is the earlier of its envelope and external-window expiries.

Each operator opcode has a distinct action challenge. Approval uses the stored approval challenge.
Candidate closure is SHA-256 over the ASCII domain
`openspell.hosted-migration-close-candidate-challenge.v1\n`, followed by the decoded raw
previous-transition, candidate and approval-challenge digests. Approval closure uses domain
`openspell.hosted-migration-close-approval-challenge.v1\n`, followed by those same three raw digests
and then the raw grant-leaf and grant-signature digests. The request's `actionChallengeSha256` and
the private authentication capability must both equal the derived value for that exact opcode.

The attended approval message contains only the expected journal/candidate identity and approval
challenge. The handler additionally requires a non-serializable `FreshAttendedAuthentication`
capability, minted inside the future root process after challenge-bound PAM/TTY/audit validation.
It supplies the operator/session digests and authentication time; the wire cannot. WP-199 provides
only a `cfg(test)` synthetic minter. The authority loads every target/evidence field from the
committed candidate, requires both private capabilities to match it exactly, reads one trusted-clock
sample under the journal lock, constructs the exact WP-197 approval grant and persists it before
returning digest-only confirmation. The same fresh-auth capability is required by either expiry
closure. Approval persists those facts in the grant; each closure persists the action-challenge,
operator-identity and authentication-session digests plus `authenticatedAt` in its transition.

The supervisor consumption message contains only the exact expected approved generation/digest,
operation id, authorization nonce and expected grant leaf/signature digests. The authority loads and
independently verifies the retained grant, requires the same authority incarnation, checks strict
expiry, draws one ticket nonce, constructs the exact WP-197 execution ticket and commits one
`approved -> consumed` successor before returning the ticket bytes and raw signature once.

## Exact time derivations

Every mutation samples the trusted clock exactly once while holding the journal lock. The sample
must be a whole UTC second and must be greater than or equal to the last trusted time in the verified
chain; regression refuses without mutation. Comparisons use instants, not text ordering.

- Registration requires `now < envelopeExpiresAt <= now + 900 seconds` and
  `now < externalExclusiveWindowExpiresAt`; its cutoff is the minimum of those two instants. Thus an
  untrusted candidate becomes eligible for attended closure within at most 900 seconds, never at a
  far-future caller-selected date. It remains nonterminal until that signed closure commits; clock
  advancement alone never mutates or releases it.
- Approval requires `authenticatedAt <= now`, `now - authenticatedAt <= 300 seconds`, and exact
  capability/candidate equality. Each of the capability's four external-window/pre-apply
  observation instants must satisfy `0 <= now - observedAt < 60 seconds`; equality at 60 seconds is
  stale. `issuedAt = now`. `expiresAt` is the minimum of envelope expiry, external-window expiry,
  `authenticatedAt + 300 seconds` and `issuedAt + 900 seconds`. It also requires
  `issuedAt < expiresAt`.
- Consumption requires `now < grant.expiresAt`; `consumedAt = now`; ticket `expiresAt` equals the
  grant expiry byte-for-byte.
- Candidate closure requires `now >= candidate cutoff`; approval closure requires
  `now >= grant.expiresAt`. Equality is expired: it refuses approval/consumption and permits only
  the exact attended closure.

The authenticated time is therefore private capability evidence, not caller-selected time, and no
grant can outlive either prepared-evidence window or its authentication freshness.

## State machine

The only mutable-operation edges in WP-199 are:

```text
empty_or_terminal -> candidate_registered -> approved -> consumed
                                  |              |
                                  v              v
                    candidate_expired       approval_expired
```

`candidate_expired` and `approval_expired` are private root-journal terminal classifications. They
require fresh attended authentication, exact compare-and-set, trusted time at or after the
relevant expiry and proof from the unique chain that no later grant or ticket exists. They are not
WP-197 `terminal_no_spawn` records and claim nothing about namespaces, cgroups, children, pidfds or
database sessions.

`consumed -> executing -> terminal|terminal_no_spawn` is future-only. WP-199 recognizes only the
five transition schemas enumerated below; every future or unknown transition is recovery-only. A
later reviewed format version must add its own exact codecs and revalidate the complete chain. Only
WP-200's launcher work and later exact zero-resource/session evidence may close a consumed ticket.

Each open draws one raw 256-bit authority-incarnation nonce once. Its digest is SHA-256 over the
ASCII bytes `openspell.hosted-migration-authority-incarnation.v1\n` followed by that raw nonce. The
open refuses rather than redraws if its digest appears anywhere in the retained chain. Each
candidate records that operation-authority incarnation. Approval and consumption require the same
live incarnation. Opening on a valid nonterminal state permanently sets a recovery latch for that
process: root status remains available for later supervisor/broker read-only reconciliation, but
registration, approval, consumption, ordinary signing, ticket entropy, key rotation and a new
operation are refused. There is no root `reconcile` opcode. A
recovered candidate or approval may only take its exact attended expired-without-successor close
edge. That narrow signing exception binds both the original operation-authority incarnation and the
current closing-authority incarnation; it does not change or revive the operation. In a same-process
closure those digests are equal; after recovery they differ.

There is at most one nonterminal operation per supplied, locked journal. Operation ids,
authorization nonces, OS-authentication-session digests, envelope digests, authority-incarnation
digests and ticket nonces are permanently unique across the retained journal. A collision refuses;
it is never regenerated inside the same request. WP-203 must prove that one exact journal is the
host-global deployment journal; WP-199 cannot prove another directory does not exist.

Each transition compares the expected generation, prior transition digest, prior state, operation
id, authorization nonce and relevant artifact digests under the singleton journal lock. Concurrent
mutations have exactly one winner.

## Immutable journal

A later installer supplies an already-open root-owned state-directory descriptor. WP-199 accepts no
path. The fixed tree is:

```text
FORMAT
LOCK
objects/leaves/<sha256>
objects/signatures/<sha256>
transitions/<20-digit-generation>-<sha256>.json
```

`FORMAT` contains exactly `openspell.hosted-migration-root-journal.v1\n`. The generation-zero
previous-transition digest is
`ca2d2cff450674f8748447a397c73c1f339c92b90dcaf4fccf6ad632a8f1eb8e`, the SHA-256 of exactly
`openspell.hosted-migration-root-journal-genesis.v1\n`.

The root directory and fixed child directories must be one local filesystem, owned by the expected
authority identity from the opaque root policy, non-writable by group/other and opened fd-relative
without following symlinks or crossing a mount. Regular files are mode `0600`, owned by the
authority and have link count one. Directories are `0700` with link counts appropriate to the exact
tree.

`LOCK` is one fixed regular inode, opened fd-relative with `O_RDWR|O_CLOEXEC|O_NOFOLLOW`, verified by
both descriptor and directory-entry metadata, and held with nonblocking Linux `F_OFD_SETLK` write
locking for the authority lifetime. Lock contention refuses startup. The descriptor is never
returned, cloned or duplicated; the library contains no fork/exec path; closing it seals that
authority instance. An in-process mutex or unrelated injected descriptor is not a substitute.

The authority also owns one private, non-cloneable in-process mutation mutex. Every dispatcher must
hold it across full inventory, clock sample, compare-and-set, object/signature/transition
publication and the single response-attempt state change. The OFD lock excludes other processes;
the mutex serializes threads sharing the same locked file description. The OFD lock covers bytes
zero through EOF. Tests race both independent processes and threads; neither primitive substitutes
for the other.

### Canonical private objects

Canonical JSON uses the WP-197 encoder: exact listed key order, two-space indentation, `: ` between
key/value, commas plus LF between fields and one terminal LF. No insignificant alternative encoding
is accepted. The untrusted candidate object has schema
`openspell.hosted-migration-root-candidate.v1` and these exact keys:

```text
schemaVersion, operationId, authorizationNonce, targetFingerprint, targetSelectionSha256,
envelopeSha256, envelopeExpiresAt, externalExclusiveWindowGeneration,
externalExclusiveWindowEvidenceSha256, externalExclusiveWindowExpiresAt,
officialSourceEvidenceSha256, nativeRuntimeIdentitySha256, childSandboxPolicySha256,
phaseExecTopologyPolicySha256, childCgroupPolicySha256, applyInvocationEvidenceSha256,
operationAuthorityIncarnationSha256, candidateBindingSha256, approvalChallengeSha256, storedAt,
cutoffAt
```

`storedAt` equals the registration mutation's trusted-clock sample; `cutoffAt` equals the exact
minimum defined above. Its object digest is SHA-256 over the complete canonical bytes. It is not
signed and never becomes approval authority by itself. Approval-grant and execution-ticket leaf
keys, domains and bytes are exactly the WP-197 schemas quoted above and independently implemented
here.

### Exact transition records

There are exactly five signed transition schemas. Each list is the exact canonical key order:

- `openspell.hosted-migration-root-candidate-registered.v1`: `schemaVersion`, `generation`,
  `previousTransitionSha256`, `transitionKind`, `priorState`, `resultingState`, `candidateSha256`,
  `operationId`, `authorizationNonce`, `envelopeSha256`,
  `operationAuthorityIncarnationSha256`, `candidateBindingSha256`, `approvalChallengeSha256`,
  `trustedAt`, `issuerPublicKeySha256`, `detachedSignatureSha256`.
- `openspell.hosted-migration-root-approved.v1`: `schemaVersion`, `generation`,
  `previousTransitionSha256`, `transitionKind`, `priorState`, `resultingState`, `candidateSha256`,
  `approvalGrantSha256`, `approvalGrantSignatureSha256`, `operationId`, `authorizationNonce`,
  `envelopeSha256`, `operationAuthorityIncarnationSha256`, `trustedAt`,
  `issuerPublicKeySha256`, `detachedSignatureSha256`.
- `openspell.hosted-migration-root-consumed.v1`: `schemaVersion`, `generation`,
  `previousTransitionSha256`, `transitionKind`, `priorState`, `resultingState`, `candidateSha256`,
  `approvalGrantSha256`, `approvalGrantSignatureSha256`, `executionTicketSha256`,
  `executionTicketSignatureSha256`, `operationId`, `authorizationNonce`, `envelopeSha256`,
  `operationAuthorityIncarnationSha256`, `trustedAt`, `issuerPublicKeySha256`,
  `detachedSignatureSha256`.
- `openspell.hosted-migration-root-candidate-expired.v1`: `schemaVersion`, `generation`,
  `previousTransitionSha256`, `transitionKind`, `priorState`, `resultingState`, `candidateSha256`,
  `operationId`, `authorizationNonce`, `envelopeSha256`,
  `operationAuthorityIncarnationSha256`, `closingAuthorityIncarnationSha256`,
  `actionChallengeSha256`, `authenticatedOperatorIdentitySha256`,
  `osAuthenticationSessionSha256`, `authenticatedAt`, `cutoffAt`, `trustedAt`,
  `issuerPublicKeySha256`, `detachedSignatureSha256`.
- `openspell.hosted-migration-root-approval-expired.v1`: `schemaVersion`, `generation`,
  `previousTransitionSha256`, `transitionKind`, `priorState`, `resultingState`, `candidateSha256`,
  `approvalGrantSha256`, `approvalGrantSignatureSha256`, `operationId`, `authorizationNonce`,
  `envelopeSha256`, `operationAuthorityIncarnationSha256`,
  `closingAuthorityIncarnationSha256`, `actionChallengeSha256`,
  `authenticatedOperatorIdentitySha256`, `osAuthenticationSessionSha256`, `authenticatedAt`,
  `cutoffAt`, `trustedAt`, `issuerPublicKeySha256`, `detachedSignatureSha256`.

`transitionKind` is respectively `candidate_registered`, `approved`, `consumed`,
`candidate_expired` or `approval_expired`. The exact legal state pairs are:

| Kind | Prior state | Resulting state |
|---|---|---|
| `candidate_registered` | `empty`, `candidate_expired` or `approval_expired` | `candidate_registered` |
| `approved` | `candidate_registered` | `approved` |
| `consumed` | `approved` | `consumed` |
| `candidate_expired` | `candidate_registered` | `candidate_expired` |
| `approval_expired` | `approved` | `approval_expired` |

Generation is one through `9_999_999_999`, increments by exactly one and is formatted as twenty
decimal digits in the filename. `previousTransitionSha256` is the genesis digest at generation one
and otherwise the SHA-256 of the complete prior canonical transition. `trustedAt` is the one locked
clock sample and never precedes the prior transition's `trustedAt`. Every operation/artifact field
must resolve to the retained object and repeat the complete predecessor binding exactly.

For schema `openspell.hosted-migration-root-<name>.v1`, the signature domain is exactly
`openspell.hosted-migration-root-<name>-signature.v1`. The signed bytes are the ASCII domain, LF and
the canonical transition with the final `detachedSignatureSha256` field omitted; the unsigned JSON
still ends with LF. The detached signature is raw 64-byte Ed25519. Its SHA-256 is added as the final
field, and the transition digest/filename digest is SHA-256 over the complete canonical transition,
including that final field and terminal LF.

The raw transition signature is stored at `objects/signatures/<detachedSignatureSha256>`. The raw
root public key and its pin live outside the journal in the opaque root policy. Before signature
verification, every `issuerPublicKeySha256` must equal that pin; a journal field can never select a
verification key.

There is no mutable `HEAD`. Startup inventories the whole tree and verifies one contiguous chain
from the pinned genesis. Every leaf/signature object must be referenced by a verified transition,
every reference must resolve to exact bytes, and every transition must resolve its own raw
signature. A gap, fork, duplicate generation, wrong filename digest, invalid signature, unknown
final-form file,
missing or altered object, impossible edge, uniqueness violation, bad ownership/mode/link count,
symlink, mount crossing, clock rollback or uncertain durability seals the authority recovery-only.
An unreferenced object is an ambiguous interrupted commit and also seals recovery-only. It never
truncates, overwrites, chooses a branch, rolls back, repairs or deletes an artifact.

## Commit and response ordering

Every mutation holds the singleton lock and follows this order:

1. inventory and verify the complete journal; then recheck the exact compare-and-set predicate;
2. revalidate every predecessor object byte-for-byte; construct the state-specific candidate, grant,
   ticket or closure evidence; draw at most the one required ticket nonce; sign signed records only
   through a narrow record-specific signer;
3. for registration publish the candidate object; for approval publish the grant leaf/signature;
   for consumption publish the ticket leaf/signature; for either closure publish no leaf. Publish
   each new object directly at its content-addressed final name using
   `O_CREAT|O_EXCL|O_NOFOLLOW`, complete write, metadata verification, file sync and the relevant
   object-directory sync;
4. construct and sign the exact transition referring to those object digests;
5. publish and file-sync the transition's raw signature object, then sync `objects/signatures`;
6. publish the transition at its final generation/digest name with the same exclusive complete-write
   and file-sync rules, then sync `transitions`; the transition is the only commit marker;
7. only after the last successful directory sync, construct and emit the response.

A uniquely visible valid successor is conservatively committed after a crash even when the final
directory-sync result was not observed. A partial or orphan final object or ambiguous syscall result
is recovery-only rather than permission to select the predecessor. Response failure never undoes a
transition. Publication uses no cross-directory rename and has no temporary or pending namespace.

An approval or consume replay never signs again. A consumed transition permanently owns its one
ticket nonce and exact ticket bytes. WP-199 never remints or returns a second ticket after a lost or
partial response. Digest-only status is available; the operation otherwise remains recovery-only
until a later package proves a legal terminal outcome.

## Signer, clock and entropy seams

The library has non-cloneable, record-specific signing methods for the approval grant, execution
ticket and exact internal transition families. It exposes no `sign(bytes)`, caller-selected domain,
key generation, key import or key-loading operation. Production key custody is absent. Tests use an
obviously synthetic deterministic seed assembled only in memory.

The root-policy, verified-envelope, attended-authentication, clock and entropy seams are crate-private
traits/capabilities implemented only by `cfg(test)` fixtures in WP-199. Production implementations
are absent. Callers cannot submit `issuedAt`, `consumedAt`, authenticated identity/session/time,
ticket nonce or authority incarnation. Clock regression, future authentication, stale
authentication, equality with an active expiry, signer failure or a one-draw nonce collision creates
no transition. Equality permits only the separately authenticated expiry closure.

## Package and capability boundary

The new private workspace package is `@wizard-ads/hosted-migration-root-authority` under
`tools/hosted-migration-root-authority`. It contains a pinned Linux-only Rust library crate plus
TypeScript cross-oracle and static-capability tests. Cargo sets `publish = false`, disables automatic
binary, example and benchmark discovery and emits only an `rlib`. All production modules,
constructors, dispatchers, signer/policy/clock/entropy traits and handle/state entry points are
crate-private; rustdoc exposes no callable item. Only `cfg(test)` can compose the harness. There is
no `src/main.rs`, `src/bin`, example, benchmark, `cdylib` or FFI surface.

Its `package.json` has no `bin`, export or runtime script. A test-only Node wrapper accepts either no
arguments or the repository's exact forwarded `--maxWorkers=1`, discards only that known Vitest
argument, and invokes the pinned Cargo and Vitest checks. CI uses its preinstalled pinned toolchain;
when local Cargo is absent, the wrapper uses this exact image without mounting credentials or
sockets:

```text
docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
```

Production Rust modules forbid unsafe code and may use only fixed-descriptor filesystem, Unix peer,
canonical encoding, hashing and Ed25519 verification/signing capabilities. Static tests forbid a
binary target, listener creation, socket path, environment access, process spawn/exec, TCP/UDP,
DNS/HTTP/TLS, database/Supabase/provider clients, secret managers, service managers, dynamic code,
generic signing and arbitrary paths in production Rust modules. Test-only package wrappers may
invoke the pinned compiler, Vitest and container fallback and are inventoried separately.

The crate does not depend on the WP-198 package. Rust tests and a TypeScript WP-198 oracle consume
one checked-in immutable golden corpus of canonical grant/ticket bytes, keys and signatures; neither
invokes the other implementation. No application or existing Cargo package imports the new package.
Static `cargo metadata`, rustdoc/public-API and repository reverse-dependency tests enforce that
boundary.

## Proof strategy

Focused tests must prove:

- exact WP-197 approval-grant and execution-ticket bytes, domains, digests, signatures and every
  repeated tuple field, with WP-198 cross-oracle agreement;
- candidate-binding/challenge dependency order, action-specific closure challenges, permanent
  authentication-session uniqueness and every one-field mutation;
- registration at exactly 900 seconds versus refusal at 901, mixed-precision equal-minimum goldens,
  and proof that time advancement alone never closes a candidate;
- a one-field-at-a-time freshness matrix: each of the four verified observation instants alone at
  age 59 seconds with the others fresh passes, each alone at age 60 refuses and each alone in the
  future refuses;
- every legal state edge and refusal of duplicate, skipped, reverse, stale, cross-operation,
  cross-nonce, cross-target, cross-envelope, cross-window and cross-key transitions;
- racing registrations, approvals or consumes across threads and processes produce one successor
  and one artifact, with fixed loser refusal;
- crash/fault cuts after every open, write, file sync, publication, directory sync and response
  boundary reopen to the complete predecessor, conservative successor or recovery-only—never a
  rolled-back capability or second consumption;
- lost and partial responses cannot remint or redeliver a ticket;
- all corrupt, truncated, reordered, gapped, forked, duplicate, extra-file, missing-object,
  permission, ownership, symlink, hard-link and mount cases enter recovery-only;
- wrong peer, endpoint, opcode, magic, version, length, hash, field order, extra/duplicate field,
  oversize, truncation, second packet and ancillary data refuse before mutation;
- privacy canaries never enter responses, logs, errors or public result values;
- the production library has no launcher, listener, network, database, Supabase, credential,
  deployment, production key or live-target capability;
- package typecheck, rustfmt, clippy, Rust tests, TypeScript cross-checks, repository lint/hygiene,
  full CI and independent High/Extra-High reviews pass.

## Deferred gates

WP-199 does not prove or perform:

- production socket creation, pathname ownership, real uid/gid/cgroup/LSM peer policy or fresh
  PAM/TTY/audit authentication;
- a production key handle, TPM/remote monotonic anchor, real power-loss storage honesty or root-
  compromise rollback resistance;
- official CLI acquisition, namespace/cgroup/pidfd/ptrace/seccomp execution or any child process;
- a target/project, credential, egress, hosted history, dry run, database lock or migration apply;
- service staging, activation, deployment, web admission, QA or promotion.

WP-200 continues with official CLI provenance and disposable synthetic launcher proofs. WP-201
through WP-205 retain the exact external authorizations and production no-go gates recorded in the
rolling handover.

References:

- <https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md>
- <https://nodejs.org/api/net.html#ipc-support>
- <https://docs.rs/rustix/latest/rustix/net/index.html>
