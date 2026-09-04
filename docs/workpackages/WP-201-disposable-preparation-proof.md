# WP-201 — Disposable hosted preparation proof without apply

Owner: private preparation-journal v2, narrow root/runtime composition bridges and the closed
history-fetch/dry-run coordinator.

Depends on: merged WP-200 closeout and exact-main CI at
`560d5e28615ea023f020f1a3d0944dff96213981`.

Architecture: `docs/design/WP-201-ARCHITECTURE.md`.

## Objective

Implement the offline, private, nondeployable preparation coordinator and proof contracts for an
exact 41-file hosted history fetch and exact five-item migration dry run on one separately authorized
disposable target, while structurally excluding apply, raw hosted credentials in the CLI cell,
broad credentials, direct CLI egress, mutation, reusable readiness and production authority.

Source behavior and proof execution are offline and synthetic. Networked dependency acquisition is
setup rather than proof evidence; its checksum-locked vendored bytes are explicit immutable build
inputs under the architecture's custody rules. No actual target, credential,
official download, hosted query or dry run is authorized by this brief or by merging its source.
No adapter candidate may be written until a reviewed read-only discovery-policy addendum, one
separately authorized disposable discovery run and a reviewed adapter-candidate architecture
addendum have fixed the observed topology, exact ignored path and deny-live boundary. The staged
candidate remains inert and externally incapable until a later reviewed final executable-policy
addendum pins its already measured bytes and complete acquisition/runtime/gateway/protocol graph.

## Owned files

- `docs/design/WP-201-ARCHITECTURE.md`, the reviewed controller preimages under
  `docs/design/wp201-controller-fixtures/`, and this brief;
- the explicitly enumerated registry, super-lock, v2 journal, storage-refactor, bridge, boundary and
  invariance files inside `tools/hosted-migration-root-authority/` from the architecture;
- the explicitly enumerated bridge, kernel-custody refactor, boundary and proof files inside
  `tools/hosted-migration-runtime-proof/` from the architecture;
- new `tools/hosted-migration-preparation-proof/` sources, manifests, fixtures and wrappers; and
- root pnpm lockfile changes required by the new package.

Do not edit `packages/shared`, applications, migrations, Supabase configuration, WP-197/WP-198,
deployment/service files, operator configuration or status. Do not change WP-199 v1 journal bytes,
parsing or recovery semantics. The source slice must not add an external adapter or live wrapper.
Status and ordinary handover updates occur only after reviewed merge and exact-main CI.

One narrow exception applies when the operator explicitly requests a capacity/continuation
checkpoint before WP-201 completes: the coordinator may update `docs/HANDOVER.md` and correct stale
`docs/PLAN.md` prose solely to align it with already-authoritative `AGENTS.md` in one standalone
documentation commit. It may record only verified state and open work. It cannot create or change a
product, implementation or security requirement, claim WP-201 acceptance or completion, update
`docs/STATUS.md`, satisfy an acceptance row, or authorize an external action.

## Required behavior

1. Add one private Rust `rlib` coordinator with `publish = false`, no automatic binary/example/
   benchmark targets and no default feature.
2. Add one state-root-scoped root-owned authority registry and OFD super-lock outside the v1/v2 journal
   inventories. It selects exactly one format/journal, compare-and-sets target generation and makes
   every externally composable v1/v2 open mutually exclusive. A second/ambiguous authority is
   recovery-only. Leave proof that this state root is unique on the host to WP-203.
3. Add a fresh preparation-journal v2 under a non-default `wp201-internal` feature with distinct
   magic, schema, signature domains and authority root. Reuse generalized crate-private publication
   machinery while proving every v1 byte, classification and recovery result unchanged. Never
   parse, append, upgrade, repair or reinterpret v1 as v2.
   Use the architecture's exact v2 layout, magic, genesis, inventory domain, limits and direct-final
   publication discipline. Step 3 accepts only an empty v2 journal in production; semantic v2
   append begins only after step 4 supplies the exact record decoders.
4. Add the exact descriptor/runtime bridge to the existing runtime-proof crate under the same
   non-default feature. Refactor and reuse custody/archive/ELF/synthetic-launcher invariants; do not
   copy them or expose the raw ABI.
5. Permit exactly the coordinator as reverse dependency/enabler of both bridges. Keep bridge types
   sealed, non-cloneable and constructible only from root-held permits, externally pinned installed
   policy capabilities or pre-opened owned descriptors. Implement only the exact signatures in the
   architecture. Static and compile-fail tests reject a caller key/digest, signer, journal handle,
   v1 apply type, application, service or second consumer.
6. Expose no listener, service, deployable launcher, production kernel adapter, generic command,
   generic network, arbitrary SQL, target parameter or agent-callable external capability.
7. Keep the future agent vocabulary fixed to `prepare()`, `status(operation_id)` and read-only
   `reconcile(operation_id)`. Do not implement a broker in this package.
8. Accept internally only an opaque `DisposableTargetSlot`, `PreparationCustody` and absolute
   `CLOCK_BOOTTIME` deadline. Accept no caller-selected target, phase, path, argv, environment, URL,
   endpoint, credential, SQL, timeout, retry or write flag.
9. Define the only operational phase type as `HistoryFetch | DryRun`. There is no third phase,
   optional dry-run boolean, apply ticket, apply argv, write approval or generic subprocess.
10. Persist and sync v2 operation intent before operation-level containment, credential or
    attestation work. Shared route-empty containment, sealed egress, stopped relays, direct queued
    credential delivery and operation-scoped attestation leases precede the first phase ticket under
    their own journaled effects. For each CLI phase, sync its `executing` state before the phase
    namespace, cgroup, child, pidfd, phase gateway lease or database session.
11. Permit dry-run ticket construction only after history child, cgroup, gateway lease and tagged
    sessions are terminal and exact 41-file evidence plus the verified 46-file bundle are committed.
12. Treat any accepted/lost/unknown effect as recovery-only until its exact immutable identities are
    reconciled. Never retry an uncertain effect or advance to the next phase. Permit only the
    architecture's separate zero-acquisition cleanup lane to release disjoint, already accepted
    exact identities while normal advancement remains frozen.
13. Permit recovery to prove no-spawn or terminalize an already-started effect only. Only a reopened
    and verified `closed` journal may reproduce the same deterministic successful response.
14. Require the exact externally pinned installed policy and root-signed authorization schema from
    the architecture, including source,
    proof-bootstrap registry/verifier, target/provider/organization, three existing credential resources, pinned credential-broker
    response signer, request verifier/domain, local peer, nonce, resource-map, store-route/DNS/TLS/
    server/protocol and runtime identities, trusted clock and entropy provider identities, policies,
    subordinate executable-manifest digest/generation, two allowed
    phases, expected counts, authenticated operator,
    duration and explicit zero lifecycle/write capability.
15. Require provider-backed
    production-target exclusion and exact agreement among project identity, target fingerprint,
    API scope, TLS host and database identity. Commit target attestation only after credential and
    gateway binding plus provider and observer evidence.
16. Model three distinct scoped upstream credentials: control-plane read, preparation database and
    independent observer database. Reject personal, organization-wide, broad service,
    cross-project, `service_role` and write/DDL-capable fallback.
17. Require both database roles to be non-superuser, `NOCREATEDB`, `NOCREATEROLE`,
    `NOREPLICATION`, `NOBYPASSRLS`, without memberships, role switching, ownership, database
    creation, DDL or mutation grants. Enumerate only exact `CONNECT`, schema `USAGE`, required
    `SELECT`, and zero direct, inherited or `PUBLIC EXECUTE`; inventory every grant/default grant.
18. Never deliver raw hosted credentials to the CLI cell. Deliver one-use operation/phase-bound
    local gateway surrogates and prove hosted credential exposure count zero.
19. Give the CLI cell no direct external route. Use only the architecture's disjoint
    operation-scoped attestation lease before ticket issuance and phase gateway lease afterward;
    bind each to its exact operation, target, process/runtime, containment, purpose and expiry, and
    bind the phase lease additionally to ticket, executing transition, CLI pidfd/cgroup/namespace
    and exec graph.
20. Implement the exact two-leg TLS design: operation-private measured CA and phase-limited SANs on
    the CLI-to-gateway leg; independent upstream WebPKI verification on the gateway leg. Implement
    the bounded fixed HTTP and PostgreSQL state machines, gateway-selected phase tag, one-to-one
    backend, cancellation refusal unless proved, and hardened zeroized gateway process.
    Treat `application_name` as diagnostic; use non-role-switchable login plus backend PID/start as
    the immutable phase-session identity and scan sessions even when the tag changes. Create and
    attest route-empty containment and fixed egress before staging the credentialless gateway and
    separately measured observer processes behind a start trap; acquire and queue each credential
    directly from the guarded broker to its stopped recipient in one effect without intermediate
    root/coordinator custody, release the trap in its own effect, and close/account for every
    process identity. Pin the broker request signer/domain and local peer, durable nonce CAS,
    immutable resource map and exact credential-store route/DNS/TLS/server/protocol policy. Require
    `recvmsg(MSG_CMSG_CLOEXEC)` plus verified `FD_CLOEXEC` for its single `SCM_RIGHTS` descriptor.
    Retain one authenticated broker control channel inside root authority, dispatch only after the
    intent, and expose a root-owned non-acquiring nonce status/abort reconciliation that cannot
    resend or open a resource. Create a genuinely distinct per-nonce `SOCK_SEQPACKET` connection,
    never an `fd` duplicate; drain/close any queued open-channel descriptor before non-delivery.
    Linearize acquire against abort through `CHANNEL_OPENING`, `CHANNEL_READY`, `ACQUIRING`,
    `DELIVERY_UNCERTAIN`, `DELIVERED`, `ABORTING` and `NOT_DELIVERED`; sync the terminal tombstone
    before any non-delivery reply. Once secret queueing may begin, never claim non-delivery: exact
    acknowledgement may prove delivery, otherwise kill/inventory the stopped task set and remain
    permanently recovery-only. Account `C/S/D/U/R/V` on every cut. Retain
    three signed secret-free terminal nonce tombstones through request expiry plus the fixed GC
    guard, then compact only into a permanent spent-nonce commitment, and bind their set digest into
    the approved closed inventory.
    Journal the credentialless egress setup helper as three effects: stage it in
    accepted containment with its task/pidfd and four namespace/egress-control handles; install and
    attest the fixed policy while irreversibly dropping authority; then prove that drop, exit/reap
    it and close the handles before any credential transfer. Arm all four stopped recipients behind
    individual duplex traps plus one shared atomic state object, require all four acknowledgements, and release
    them only with the single all-or-nothing group commit. Keep the release inside the registered
    authority: use four authenticated duplex channels, an independently sealed full-digest binding
    record and a separate root-writable/task-read-only atomic `u32` state. Commit and
    signal/deadline/cleanup revocation must be competing terminal compare-exchanges; tasks may not
    upgrade their mapping or pass the trap after `REVOKED`. Define the CAS as the linearization
    point, require every task to enforce the sealed absolute `CLOCK_BOOTTIME` release deadline after
    `COMMITTED`, and prohibit credential use, target sockets or later leases without a fresh
    root-side deadline/signal/cleanup check.
21. Enforce fixed DNS policy with numeric-address connection after validated resolution and exact
    SNI/Host/target/peer agreement. Reject redirects, rebinding, proxy variables,
    private/metadata destinations and direct-route bypass. Freeze the absolute authorization
    deadline into cgroup ingress/egress BPF using `bpf_ktime_get_boot_ns`, drop both directions for every
    new or existing socket at/after it, and additionally check before every DNS/connect/TLS/socket/
    HTTP/PostgreSQL operation. Prove a held connection admits zero packets after the boundary.
22. Keep public-release acquisition credential-free in a distinct helper/process/namespace with
    fixed routes and no target reachability. Publish only to root-owned descriptors and satisfy the
    WP-200 fixed release policy.
23. Complete only preparation-scoped official source/runtime and history/dry-run topology evidence.
    Do not claim final all-phase `nativeRuntimeIdentitySha256` or `releaseProvenanceSha256`.
24. Version both preparation ticket and invocation records so preparation-scoped runtime facts and
    gateway surrogate values never populate or reinterpret frozen v1 all-phase fields. Bind
    gateway policy, upstream scope and zero raw exposure; bind actual gateway lease after executing.
25. Fix dry-run argv to contain `--skip-vault` and `--dry-run` in reviewed order. Refuse missing,
    duplicate, reordered or option-terminated variants before spawn.
26. Compile the observer query corpus; accept no SQL. Close public acquisition before credential
    acquisition. Run and fully close observer preflight before the history ticket; run postflight
    only after dry-run execution/session closure. Account for each observer lease, transaction,
    socket and backend. Treat instantaneous observation as evidence, never an apply-race lock.
27. Reconcile history to exactly 41 files, 279,677 bytes, terminal version `20260901010000`, fixed
    order and the WP-197 baseline digest. Reject missing, extra, linked, replaced or truncated data.
28. Accept a prebuilt, root-owned sealed WP-197 bundle only by descriptor. Independently verify its
    exact 46 files, 646,628 migration bytes, manifest/source/version/digests, compare every baseline
    byte to fresh history, and construct the CLI workdir without Node in the privileged operation.
29. Reconcile dry-run offered, parsed and matched counts to exactly five, versions
    `20260901020000` through `20260901060000` in order, 366,951 bytes and zero execution/mutation.
30. Require byte-identical pre/post target, ledger, queue, recommendation, schedule and out-of-scope
    privilege fingerprints, plus a lossless phase-session census and zero remaining sessions.
31. Enforce the architecture's exact 3,600-second deadline, 180-second cleanup reserve, component
    budgets and numeric journal/output/HTTP/PostgreSQL/observer/DNS/resource caps. A deadline,
    signal or overflow disqualifies success. Convert authorization expiry to a `CLOCK_BOOTTIME` deadline at
    open, cap every work/lease/ticket deadline to it and enter cleanup-only at expiry.
32. Implement the exact per-effect `intent -> accepted|no_accept -> closed` records, immutable
    recovery anchors, 23-component signed resource vector, 43-row delta/anchor table, 43-effect
    successful tape and fixed generation 149 with a zero
    terminal vector. Generate legal, wrong/lost-result, interruption, deadline and storage-sync cuts
    from that tape. Never retry or normally advance past an unclassified effect; only journaled,
    zero-acquisition cleanup of disjoint accepted identities may proceed in recovery-only state.
33. Commit an observation core without closure claims, then close all effects, commit independent
    conservation and the terminal transition, reopen the journal, and only then derive the final
    response envelope. A lost response is reproducible only from that verified closed journal.
34. Keep raw refs, endpoints, credentials, provider bodies, database rows, output, paths, PIDs,
    errors and private topology out of public results. Prove canary absence in CLI-visible state,
    evidence, logs, panics and cleanup failures.
35. Emit only fixed refusal/recovery outcomes or the exact closed non-authorizing observation with
    bounded counts/digests, `writeCapability: false`, zero write effects and terminal state
    `closed_no_apply`.
36. Put no raw target, bearer, credential, endpoint, argv, SQL, output, path, PID/fd, approval,
    execution ticket, live lease, apply invocation, production freeze/window or readiness label in
    that observation.
37. Prove exact conservation: zero uncertain resource, child, pidfd, cgroup, socket, gateway lease,
    tagged session, guard, credential, egress namespace, watcher and ephemeral-root residue.
38. Keep source proof cases synthetic and offline. They must not contact Supabase, a browser, a real
    database, a service, production data, a provider or Amazon. Ambient repository CI may run its
    unrelated PostgreSQL suites. For a cold container run, the reviewed wrapper uses the exact
    bounded acquisition and proof-container protocol in the architecture;
    any `wp201-internal` bridge-success or coordinator-success run must use the row's fresh root,
    network-disabled proof container even when the local toolchain exists. The networked operation
    is not evidence, while its checksum-locked vendored dependencies and independently pinned
    toolchain bytes are explicit ledger-bound, read-only build inputs.
    Neither phase may become an external adapter. Use exact-ID preinspection plus `--pull never`,
    the architecture's exact eight-entry selected-manifest annotation map, its raw inspected
    lifecycle-state-dependent `HostConfig.OomKillDisable` Boolean-`false`/JSON-`null`
    representation, root proof `--read-only`/capability/no-new-privileges isolation and its
    immutable-label create-response reconciliation. Enforce its absolute boot-time deadlines:
    300-second
    acquisition or 900-second proof active budget plus one 160-second total cleanup reserve. Allocate
    it exactly as the architecture's 15-second create settlement, 10-second mutually exclusive
    other-active-child or post-settlement exact-name-recovery slot with the fixed five/two/three
    normal/TERM/KILL-reap split, 80-second two-ID/two-remove recovery, 10-second preliminary
    pre-CLOSE census,
    10-second watcher settlement,
    10-second post-CLOSE census/socket check, 15-second permission-restoring path-helper including
    final absence, and 10-second scheduling reserve. Never issue more than two removes for one exact
    ID, require an absence inspection after the first attempt and after any required retry, preserve
    an in-flight cleanup operation/result across the latch without restarting its state, and settle
    any final event learned during watcher closure before the one final census.
    Bind each epoch-backlog watcher to OPEN v2's closed invocation/role/exact-name tuple, one
    invocation-label filter value and a separate exact-name `container` filter; treat that daemon
    filter only as narrowing and require exact client-side role/name identity before custody.
    Latch the first signal, pre-establish the exact same-daemon event stream and route success and
    every refusal through one outer cleanup `finally`. Any unconfirmed child, container or pathname residue
    refuses and cannot emit success.
39. Keep the external proof adapter absent from this source slice. Later, land and use the separately
    reviewed non-writing discovery policy, then land an adapter-candidate architecture addendum that
    fixes the ignored path and deny-live boundary before staging the exact inert candidate. Measure
    those fixed bytes offline under the compiled deny-live policy, and only then land the final
    signed executable policy with every official URL/redirect, immutable subordinate executable/
    runtime/rootfs byte, broker store-leg policy, gateway CA/TLS/protocol table and phase exec graph.
    Use a separately reviewed WP-201 nondeployable proof-bootstrap registry to pin a verifier/root
    launcher that embeds only the policy/activation signing keys/domains and is excluded from the
    subordinate manifest it authenticates; never create a manifest/binary self-hash cycle or depend
    on the later WP-203 deployable installer.
    Release a separately authenticated one-use capability only to that unchanged pinned candidate;
    any changed byte requires a new candidate and policy.
    Measure every acquisition helper, root custodian, credential broker, gateway, observer and adapter descriptor before
    secret/network release; source revision alone is not provenance.

## Explicit exclusions

WP-201 does not:

- create, seed, link, pause, delete or mutate any Supabase project;
- provision, rotate, revoke, reveal or request a broad credential;
- acquire official assets or run the official CLI without separate exact authorization;
- run hosted history fetch, dry-run, apply, repair or pull under source/merge authority;
- implement apply, a reusable prepared lease, production lock handoff or final all-phase provenance;
- create a broker, listener, binary, deployable service, systemd unit or production signer;
- stage, activate, restart, promote or mutate live infrastructure;
- change a worker, queue owner, web/MCP revision, feature admission or Amazon write state; or
- update rolling status or make an ordinary handover completion claim before reviewed merge and
  exact-main CI; the narrow operator-requested continuity checkpoint above remains allowed.

## Implementation order

1. Commit this architecture and brief before implementation.
2. Add bridge feature declarations and exact dependency/reverse-dependency boundary tests.
3. The local checkpoint at `c36b680` contains the minimal synthetic installed-policy and
   installation-authorization codecs/trust checks, state-root installer, bootstrap lease,
   super-lock, signed registry generation one, empty v2 journal storage and durable
   no-feature/feature v1-invariance work. That portion is not accepted until the remaining
   root/container composition proof passes. The architecture's step-3 exactness amendment freezes
   the `openspell-wp201-root-proof-` invocation prefix, `com.openspell.wp201.*` labels, versioned
   acquisition/proof roles, fixed temporary parents, tracked regular-file-only source snapshot plus
   its four exact compile-time JSON inputs, built-in `bridge` acquisition network, `linux/amd64`
   platform manifest/config/rootfs, exact index create reference and two allowed Docker
   content-store inspection-ID representations, exact Docker-client and not-found classifications,
   nine pre-network Cargo-input hashes, a hard-1-GiB acquisition tmpfs and bounded USTAR decoder,
   closed Docker operation/create-argv tables, complete mount/namespace/security/resource layouts
   plus the host/container namespace gate,
   independently pinned Rustfmt/Clippy toolchain and controller bytes, the 4,853-record LF/TSV
   source-directory-vendor-toolchain-control ledger, request-flushed OPEN/CLOSE event-helper
   protocol with explicit global-backlog limits and cleanup-only exact-name recovery, no-argument
   identity-bound three-state permission-restoring path-cleanup protocol,
   two-remove exact-ID recovery under the 160-second cleanup reserve, a pure sealed fault model and
   a mandatory smaller real-Docker compatibility suite, and
   one fresh proof container for each of the
   28 ordered Cargo/positive-marker rows. For each of the three interruption cuts, the supervisor
   must use the frozen bounded no-follow copier to build one fresh, independently reverified
   `ledger-backed` root, retain its own root/ledger custody, and pass only the exact fd-`7` root
   capability to the no-argument harness. Harness telemetry is equality evidence, never cleanup or
   pathname authority. Before a cut passes, use that retained custody to prove the ledger identity
   and digest with link count zero, the root identity empty and unlinked with link count zero, then
   prove exactly those two retained descriptors and no duplicate in the supervisor table, close
   both, and prove `EBADF` plus neither identity remaining. A post-close anomaly uses only bounded
   descriptor-identity settlement; it cannot invoke pathname cleanup without both capabilities.
   The authoritative cut supervisor owns a separate 50-second post-reap acceptance interval
   outside the harness's existing 160-second cleanup reserve: three ten-second Docker checks, five
   seconds for local process/path absence, ten seconds for custody settlement and five seconds
   scheduling reserve. Failed-cut helper completion likewise
   requires the ledger's authenticated bytes and terminal link count zero plus the root
   empty/unlinked at link count zero. After every helper outcome, run the separate descriptor phase
   unconditionally: a clean exact-one state closes normally, while helper refusal or any mismatch
   enumerates/closes only matching supervisor descriptors and remains cleanup failure.
   Bind the reached-cut release ordering with the architecture's v2 one-use 32-byte freshness
   challenge: mint it only after the first exact `SIGTERM` permanently latches revocation, emit it
   in the exact acknowledgment, permanently bind the first successful proof-engine parse to that
   child token and source-fixed case, let only that receipt build the matching release without a
   separate case selector, and require the final audit to bind the same challenge without
   exposing it in its terminal receipt or any Docker, cleanup, pathname or public authority.
   Test external ledger hardlink and rename refusal, supervisor descriptor-duplicate refusal and
   the ordinary terminal two-object unlink. A permanently
   failed, fully reaped cut may use only the architecture's
   retained-capability subset teardown, and that teardown can never upgrade the cut. Bind each
   fresh-root copy to its 300-plus-25-second construction deadline, each harness to its independent
   900-plus-160-second inner deadline inside its supervisor's 900-plus-210-second cut deadline, and
   permanently failed supervisor teardown to its separate non-upgrading 130-second deadline.
   Exact-name recovery may return a validated full ID
   for deletion, but a name or label is never a deletion operand. Independently
   review the exact architecture-and-brief hash, then
   implement only that fixed container-wrapper portion. First regenerate the stale coordinator lock
   with the pinned toolchain: its package/registry/checksum counts remain `68/65/65`, while its root-
   authority entry gains the already-declared `zeroize` edge so acquisition can pass `cargo fetch
   --locked`. This step exposes only internal installation and inspection; the remaining operation
   authorization, record, transition, policy and preparation-machine contracts belong to step 4.
4. Commit and independently review the exact remaining v2 record/transition/domain contract, then
   implement private canonical records, fixed policies and preparation machine.
5. Implement target/credential/gateway/egress/observer/history/dry-run models.
6. Derive exhaustive cut/adversarial/privacy/conservation tests from the successful tape.
7. Prove the external adapter is absent and ordinary CI cannot authorize a live route.
8. Run High correctness and two Extra-High authority/crash reviews; correct every finding.
9. Run focused, blast-radius and full repository verification.
10. Push, open a PR and require exact-head CI before merge; require exact-main CI after merge.
11. Update status and the ordinary completion handover only after the source slice is merged and
    verified; the narrow operator-requested continuity checkpoint above remains allowed.
12. Commit and independently review the read-only discovery-policy addendum before touching an
    official asset, disposable target or credential.
13. Under fresh authorization, run that bounded non-writing discovery harness; its private trace is
    review evidence, never executable policy or preparation success.
14. Commit and independently review an adapter-candidate architecture addendum that fixes the exact
    ignored path, interfaces, deny-live construction and nondeployable proof-bootstrap verifier/
    append-only activation registry before adding the file. The verifier embeds only the final-
    policy/activation signing key/domain, not a future policy/manifest digest. Activation CASes to a
    newer tuple under an exclusive bootstrap/state-root lock and refuses while any bound operation
    is nonterminal; mutation open/active recovery requires current equality. Closed read-only
    recovery may verify its exact journal-bound historical chain tuple and cannot regain mutation.
15. Implement and independently review the inert ignored adapter candidate under the compiled
    deny-live policy; build it reproducibly offline and record its immutable provenance.
16. Commit and independently review the final executable-policy addendum, pinning the already staged
    candidate plus every subordinate privileged executable/runtime and observed protocol edge in a
    signed generation-bound manifest. Exclude its independently proof-bootstrap-pinned verifier/
    launcher; WP-203 later revalidates the mechanism for deployment.
17. Only after that addendum merges, repeat independent reviews/CI and request fresh authorization
    that releases one non-reusable execution capability to the byte-identical candidate.

## Source acceptance

- pinned `cargo fmt --check`, `cargo check --locked`, clippy with warnings denied, rustdoc with
  warnings denied and `cargo test --locked` for all three crates and bridge feature combinations;
- root-authority CI separately runs no-default-feature and `wp201-internal` check, clippy, rustdoc
  and test commands through its reviewed pinned-toolchain wrapper; wrapper boundary tests prove an
  acquisition-only locked fetch and a distinct network-disabled/offline proof container;
- exact module, dependency, feature and reverse-dependency inventories;
- executable root-container proof that the trusted procfs root and fixed root-owned, mode-`0555`
  `/proc/sys` directory have distinct statx mount IDs; only that single fixed component may cross a
  mount, while `kernel/random/boot_id` is a root-owned, mode-`0444`, link-count-one, size-zero,
  read-only regular procfs file opened below it with mount crossing forbidden and the numeric-PID
  time-namespace read also forbids mount crossing;
- negative boot-ID proofs for a mount below `sys`, final-component bind substitution, symlinks or
  magic links, non-procfs descriptors, pathname-to-fd identity replacement, wrong device/inode/
  mount identity, type, owner, mode, link count, size, access/append flags or missing `FD_CLOEXEC`,
  with both clock samples exercising complete reopen and revalidation;
- deterministic golden regeneration comparison;
- exhaustive pure transition/effect/cut/resource accounting;
- credential, target, egress, DNS/TLS, gateway, session, output, privacy and mutation deny matrices;
- exact history/workdir/dry-run count, byte, order and digest tests;
- executable proof that no WP-201 apply phase/argv or other write authority is reachable through the
  bridges, plus no generic execution/network/SQL, production credential source,
  deployment/service or application import;
- executable proof that the source slice contains no external adapter and no live-authorizing
  policy fixture;
- root `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm hygiene` and `git diff --check`;
- one independent High correctness review; and
- two independent Extra-High credential/egress/crash/recovery reviews.

## Separately authorized external acceptance

The real disposable proof is a later gate. It requires the reviewed discovery evidence, final
executable-policy addendum and ignored proof adapter, then fresh authorization naming exactly one
disposable target and expiry,
attended official acquisition, exact minimum-scope credentials, lossless connection/session
evidence, measured official phase graphs, exact 41/46/five evidence, byte-identical target
postflight and zero resources/mutation. Its sole public success line is:

```text
openspell disposable preparation proof: history=41 dry-run=5 write=0 sessions=0 residue=0
```

If any target scope, gateway, official runtime, phase topology, session census, cleanup or no-change
fact is unproved, external acceptance fails and WP-202 remains blocked. No broad fallback is allowed.

## Handoff

WP-202 receives only the canonical closed observation and reviewed private composition interfaces.
It receives no live custody or authority. It starts under fresh exact disposable-target
authorization and revalidates freshness-sensitive preparation before its separately designed apply
phase and two-stage lock proof.
