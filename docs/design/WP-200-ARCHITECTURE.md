# WP-200 architecture: official CLI custody and synthetic runtime proof

Status: selected for implementation on 2026-09-03.

Base: `origin/main` at `92696471e2d75d333613348d99a386a67a70506c`.

## Outcome

WP-200 adds a separate private Rust library and two disposable proof harnesses for the future
hosted-migration launcher. It proves that:

- already-open release assets can be checked against the fixed Supabase CLI 2.116.0 release facts,
  safely extracted into immutable descriptor-owned custody and revalidated without trusting a path,
  environment or host executable;
- a closed launch state machine admits only the fixed synthetic front-controller/delegate graphs;
- a real Linux proof adapter establishes namespace, child-only cgroup, pidfd, ptrace exec-stop,
  executable-map and post-exec process-protection invariants before releasing synthetic code; and
- every modeled durability or kernel-effect cut either closes with exact counts or remains
  recovery-only, never reusable or successful by cleanup assumption.

The package has no binary, listener, production kernel adapter, live acquisition transport, target,
credential, database, Supabase invocation, service or deployment artifact. The official CLI is never
executed in WP-200. The real-kernel adapter executes only checked-in synthetic test programs inside a
networkless disposable proof container.

## Reconciled starting point

WP-199 and its closeout are merged at the base revision. PR #129 and PR #130 passed exact-head and
exact-main CI. There are no open pull requests. The hosted ledger still has 41 versions through
`20260901010000`; the five reviewed suffix migrations remain source-only. Production web remains at
`44da7ac`, production MCP remains at `b5c210d`, the two new worker units remain absent and the active
legacy worker revision remains unproven.

WP-197 fixes the official release, runtime, sandbox, topology and cgroup evidence vocabulary.
WP-198 verifies supplied signed records and transcripts but has no external capability. WP-199 owns
the only root journal implemented so far and stops at durable one-use ticket consumption. WP-200
does not modify that journal, add an `executing` transition or make its private crate public.

The current host permits unprivileged user namespaces but does not delegate a writable cgroup-v2
root to the operator. A default private container also sees cgroup v2 as non-writable. A private
privileged container has a writable private cgroup-v2 namespace. Therefore real cgroup proof belongs
in a narrow disposable test container, not in the ordinary package process or shipped library.

## Safety fact

A correct archive digest is not acquisition authority. A synthetic launcher proof is not evidence
that the official CLI has run, that a target is correct or that a migration is safe. A durable
WP-199 ticket cannot be reused as a synthetic test permit.

WP-200 consequently separates four evidence classes:

1. fixed official release policy compiled from reviewed WP-197 constants;
2. official source components derived only from root-anchored pre-opened descriptors;
3. synthetic source/runtime components derived under separate test-only pins and domains; and
4. disposable kernel observations that can close only a synthetic proof operation.

No conversion exists from a synthetic class to an official class. No WP-200 result is named
`authorized`, `approved`, `safe_to_apply`, `ready_to_apply` or `deployed`.

## Architecture candidates

| Candidate | Starting constraint | Strength | Decision |
|---|---|---|---|
| A. Extend the WP-199 crate | Smallest internal call surface | Direct test composition and no new package | Rejected because WP-200 would take ownership of the merged WP-199 package and mix journal custody with future launcher knowledge |
| B. Separate imperative kernel custodian | Hostile caller and split authority | Strong descriptor-only role separation and independent ticket verification | Retained for the package/capability boundary, but an imperative fault matrix can drift from the real launch order |
| C. Separate closed effect machine | Deterministic crash and lifecycle proof | One transition system drives both exhaustive model cuts and real Linux behavior | Selected, combined with B's separate package and synthetic-only kernel authority |

The selected design does not add Candidate C's proposed journal v2. That would change WP-199's
format and claim crash-reconciliation authority assigned to WP-202. WP-200 instead uses a distinct
synthetic proof journal whose schema, key and domain cannot be accepted by WP-199 or WP-198.

## Package and authority boundary

Create `tools/hosted-migration-runtime-proof` as a Linux/x86-64 private workspace package:

- Rust `rlib` only, `publish = false`, no automatic binary, example or benchmark targets;
- no public Rust item, FFI, npm export, `bin`, runtime command or reverse dependency;
- production code may perform only bounded parsing, hashing, canonical encoding and operations on
  descriptors already passed by a future crate-internal composer;
- no production module may create a process, namespace, cgroup, socket or network connection;
- the pure effect machine is production-compiled but has no effect adapter or constructor capable of
  reaching the OS; and
- model and real Linux adapters, synthetic executables, fault injection and signer fixtures are
  compiled only by tests.

The package does not import the WP-199 Rust crate. Tests independently decode a checked-in immutable
copy of the WP-199 grant/ticket golden corpus and compare it byte-for-byte with the authoritative
corpus. This is test evidence, not a runtime dependency or duplicated contract.

## Deep interfaces

The future crate-internal acquisition composer supplies only already-open handles:

```rust
fn seal_release<C: EvidenceClass>(
    incoming: RootAnchoredPair<C>,
    destination: FreshRetainedRoot,
) -> Result<RetainedRelease<C>, ProvenanceRefusal>;
```

`seal_release` owns input revalidation, hashing, checksum parsing, archive parsing, publication,
sync and final reopen. The caller cannot select a release, filename, archive rule, destination name,
digest algorithm or retained layout.

The test caller supplies one complete synthetic case:

```rust
fn prove_synthetic_case(
    case: VerifiedSyntheticCase,
    effects: &mut impl TestEffectAdapter,
) -> SyntheticProofResult;
```

The effect adapter trait and this constructor are `cfg(test)`. The caller cannot invoke individual
launch stages, select argv, environment, topology, namespaces, cgroup limits, executable or cleanup
behavior. `ModelKernel` and `LinuxProofKernel` implement the same closed effect vocabulary.

No production signature accepts a pathname, URL, target, project reference, database string,
credential, command, argv, environment map, pid, cgroup name, phase switch or apply flag.

## Fixed official provenance

The production policy contains exactly these WP-197 facts:

- repository `supabase/cli`, release `v2.116.0`;
- `checksums.txt`, 1,414 bytes, SHA-256
  `54f8d735be5b852a5f10afb116eeca46336f12aa4b398ee1fe26e5efd8ab35aa`;
- `supabase_2.116.0_linux_amd64.tar.gz`, 56,699,663 bytes, SHA-256
  `5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158`;
- `supabase`, 96,900,296 bytes, SHA-256
  `3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4`; and
- `supabase-go`, 43,892,898 bytes, SHA-256
  `1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1`.

There is no runtime policy injection. Tests use a sealed `SyntheticEvidence` policy with small
fixtures through the same parsing and publication engine. The result type preserves its evidence
class and cannot become `RetainedRelease<OfficialEvidence>`.

### Input admission

`RootAnchoredPair<C>` consumes descriptors for one fresh intake root and exactly two regular files.
The private constructor records a root-to-leaf ancestor walk from an already-open filesystem-root
descriptor and requires every component to be owned by the expected root identity, not writable by
group or other, not a symlink, not a mount crossing and stable by device/inode/mode/uid/gid before
and after each read. Both assets require one link, exact size and stable metadata.

WP-200 does not download the assets. A future attended helper may supply official handles only after
its separately authorized fixed transport has completed. Agent-produced, user-owned, package-cache
or path-only input cannot enter the official constructor.

### Archive transaction

The transaction is one deep operation:

1. stream and hash the checksums asset under a fixed bound;
2. require exactly one canonical line naming the pinned archive and digest;
3. stream and hash one gzip member, refusing concatenated or trailing compressed data;
4. parse bounded 512-byte tar headers internally;
5. accept exactly the two one-level regular files in sorted inventory order;
6. refuse links, sparse/PAX/GNU extensions, devices, FIFOs, sockets, duplicate or nested names,
   absolute paths, traversal, extra entries, oversized metadata and unconsumed data;
7. write fixed names under a consumed fresh destination using exclusive fd-relative creation;
8. verify count, byte and digest conservation, sync each file and directory, then publish one sealed
   inventory last; and
9. reopen and revalidate every retained byte before returning.

Failure consumes the destination and never returns a reusable object. Production does not delete,
repair, overwrite or retry an ambiguous partial tree. Disposable tests remove only their own outer
laboratory after all handles close.

## Runtime components

The ELF verifier parses bytes; it never uses `ldd`, a loader or an executable:

- exact ELF64/x86-64 headers, program headers, interpreter and dynamic sections;
- the statically linked delegate;
- complete `DT_NEEDED` names and descriptor-relative resolution within one supplied root;
- exact file inventory, modes, owners, link counts, mounts, sizes and digests; and
- rejection of host-backed paths, writable objects, unknown executable mappings, extra files,
  unsupported features and dependency substitution.

WP-197 does not yet contain the official interpreter/dependency digests or the measured per-phase
front-controller/delegate graph. WP-200 therefore cannot emit a complete official
`nativeRuntimeIdentitySha256` or `releaseProvenanceSha256`. It returns only typed official runtime
components. Synthetic fixtures can complete a synthetic identity and exercise every rule. Filling
the official missing values requires later separately authorized acquisition and disposable-target
proof; they are never inferred from the host.

## Closed effect machine

The machine owns the full synthetic lifecycle:

```text
verified synthetic ticket
  -> durable synthetic launch intent
  -> private namespaces established
  -> exclusive child cgroup established
  -> stopped child plus pidfd owned
  -> ptrace and descendant custody established
  -> exec stop and maps attested
  -> post-exec protections attested
  -> one-use resume permit consumed
  -> descendants drained
  -> child terminal and cgroup empty
  -> durable synthetic terminal proof
```

The transition reducer emits one closed `Effect` enum. Only the expected observation can advance
the state. An effect failure before the durable launch intent returns a fixed refusal with exact zero
resource counts. Any failure or uncertainty after that intent returns `recovery_required`; it cannot
rewind, mint another resume permit, declare cleanup successful or run the case again.

The one-use `ResumePermit` is constructed only after the exec, maps, cgroup, uid/gid, capability,
`no_new_privs`, core-limit, dumpability and seccomp observations match. It is non-cloneable and
consumed by the single resume effect. This makes "verify before resume" structural rather than a
test-order convention.

Every effect declares whether it may create a namespace, cgroup, child, pidfd or resumed process.
The machine reconciles offered effects, accepted effects, refused effects, observed execs, pidfds,
children, descendants and terminal resources exactly.

## Model proof

`ModelKernel` records one successful effect tape, then derives every reachable refusal, lost-result,
wrong-result and interruption cut from that tape. The test does not maintain a parallel handwritten
fault-point list.

For every cut it proves:

- no effect occurs before its required durable predecessor;
- a pre-intent failure has zero namespace/cgroup/child/pidfd/resume counts;
- a post-intent failure remains recovery-only;
- an uncertain child or cgroup is never counted as terminal;
- no resume occurs without consuming the one permit;
- no ticket/case can spawn twice after a lost response; and
- all successful input, exec, process and terminal counts conserve exactly.

Hostile model observations cover stale/reused pids, pidfd loss, cgroup escape, unexpected fork,
clone, vfork or exec, reordered/substituted executables, extra/writable/deleted/host mappings,
namespace-root drift, wrong capabilities, dumpability reset, nonzero core limit, seccomp refusal and
cleanup ambiguity.

## Real Linux proof

`LinuxProofKernel` is test-only and executes the same fixed cases. One small `linux_abi` test module
owns any unavoidable unsafe `clone3`, pidfd and ptrace ABI; all production modules forbid unsafe
code. Safe `rustix` or `nix` APIs are used wherever they provide the exact operation.

The proof establishes:

- private mount, PID, proc, user, IPC, UTS and network namespaces;
- one private cgroup-v2 subtree containing the child and every descendant but not the supervisor;
- atomic leader pidfd custody and pidfd custody for every traced descendant;
- `PTRACE_O_EXITKILL`, fork/vfork/clone/exec stops and exact parent/child/start identity;
- retained executable identity, namespace-root identity and every bounded file-backed map before
  application resume;
- empty effective, permitted, inheritable, bounding and ambient capability sets;
- `PR_SET_NO_NEW_PRIVS`, core limit zero and dumpability reset to zero after each exec;
- rejection of a later nonzero dumpability change by the installed seccomp policy; and
- pidfd terminal observation plus an empty cgroup after success, refusal, timeout and tracer death.

An unexpected process, exec, mapping, identity or protection result consumes no resume permit,
kills the complete child cgroup and remains recovery-only unless terminal/empty observations are
conclusive. PID text is evidence only; it is never an authority handle and is not reopened after
its pidfd reports exit.

### Disposable proof container

The ordinary package test runs the model, provenance, parsing and static boundary suites without
privilege. A separate `test:kernel` wrapper:

1. builds the one synthetic kernel-test executable with the pinned Rust toolchain and locked graph;
2. identifies and hashes that exact executable;
3. starts the same pinned Rust image with a private cgroup namespace, `--network none`, read-only
   root, fresh tmpfs state and no repository, user directory, credential, browser, Docker socket or
   service mount;
4. gives that container only the privilege needed for the disposable kernel proof; and
5. requires the exact executable to report all cases and counts before Docker removes the container.

The reviewed image is:

```text
docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
```

The wrapper refuses when Docker, cgroup v2, required namespace/ptrace behavior or exact cleanup is
unavailable. It never silently skips. CI runs this proof in the disposable GitHub runner VM. A local
operator can run it explicitly; ordinary local repository tests do not silently start a privileged
container.

## WP-199 composition

WP-200 independently verifies the exact WP-199 grant and ticket golden bytes, signatures, issuer
pin, expiry and all repeated operation, authorization, target, envelope, runtime, sandbox, topology,
cgroup and invocation digests. Every one-field mutation refuses.

That verification is necessary but cannot operate a real journal. The synthetic effect machine uses
a separate fixture key, schema and signature domain. It cannot append to the WP-199 journal, produce
a `RootVerifiedPreparedEnvelope`, consume a real ticket, create a production execution permit or
claim `executing`, `terminal` or `terminal_no_spawn` state. WP-199 remains the only writer of its v1
journal and continues to treat unknown later transitions as recovery-only.

WP-202 retains ownership of the real two-stage lock handoff, execution transitions, crash/lost-
response reconciliation and terminal/no-spawn classifications.

## Module map

```text
tools/hosted-migration-runtime-proof/
  src/
    policy.rs              fixed official and sealed synthetic pins
    provenance.rs          complete descriptor-to-sealed-source transaction
    archive.rs             bounded gzip/tar parser and count conservation
    elf.rs                 nonexecuting ELF/runtime inventory verifier
    canonical.rs           private canonical evidence encoding and hashing
    ticket.rs              independent WP-199 golden decoder/verifier
    machine.rs             pure state/effect reducer and one-use resume permit
    lib.rs                 private module inventory; no exports
    model_tests.rs         exhaustive derived fault cuts
    provenance_tests.rs    synthetic archive and descriptor adversaries
    linux_abi.rs           cfg(test), audited raw Linux boundary only
    linux_kernel_tests.rs  cfg(test), real synthetic-binary proof
    boundary.test.ts       package, source and capability inventory
  fixtures/
    wp199-grant-ticket-v1.golden.json
  scripts/
    cargo.mjs
    test.mjs
    kernel-proof.mjs
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  package.json
  README.md
```

Modules own knowledge, not temporal fragments. `provenance.rs` owns admission through sealed reopen;
`machine.rs` owns the lifecycle through exact closure; adapters implement effects but cannot choose
legal ordering.

## Failure and privacy surface

The only outward test result is a frozen bounded summary or a fixed refusal:

```rust
enum ProofRefusal {
    SourceUnavailable,
    SourceMismatch,
    ArchiveRejected,
    RetentionUncertain,
    RuntimeMismatch,
    TicketMismatch,
    KernelInvariantUnavailable,
    TopologyMismatch,
    ProcessProtectionFailed,
    RecoveryRequired,
    CleanupUncertain,
}
```

Internal failures never echo asset bytes, filesystem paths, process environments, pids, target-like
canaries, signatures or nested OS errors. Static and dynamic privacy tests search all result, log and
error surfaces.

## Proof plan

Focused acceptance proves:

- every fixed official release constant and canonical source-evidence field;
- positive synthetic two-entry retention with offered/parsed/published/reopened count and byte
  conservation;
- checksum, gzip, tar, pathname, entry, size, digest, trailing-data and decompression-bound
  adversaries;
- descriptor replacement, metadata drift, owner/mode/link/mount/ancestor mutation and every
  publication/sync cut;
- ELF format, architecture, interpreter, dependency, inventory and host-mapping adversaries without
  executing an input;
- synthetic/official type separation and inability to complete official runtime/provenance from
  placeholder or host-inferred values;
- byte-for-byte independent WP-199 golden agreement and refusal of every ticket mutation;
- exhaustive model cuts generated from the successful effect tape;
- real Linux namespace, cgroup, pidfd, ptrace, exec-map, dumpability, capability, core and seccomp
  proofs with no skipped assertion;
- exact zero resource residue and no surviving synthetic process/container after every real case;
- production source contains no public item, binary, process/namespace/cgroup/socket/network/
  database/Supabase/credential/service/deployment capability or arbitrary input surface;
- package checks, repository CI, public hygiene and exact-head/exact-main CI; and
- one independent High correctness review plus two Extra-High authority/kernel/crash reviews.

## Owned files

WP-200 owns:

- this architecture and the WP-200 work-package brief;
- the new private `tools/hosted-migration-runtime-proof` package and synthetic fixtures;
- its pinned Rust/tooling manifests and root pnpm lockfile registration; and
- the minimal CI step that runs the explicit disposable kernel proof, if ordinary repository test
  discovery cannot run that proof safely.

It does not edit `packages/shared`, applications, database packages, migrations, Supabase
configuration, deployment/service files, WP-198, WP-199 or production operator configuration.

## Explicit exclusions

WP-200 does not:

- download or authenticate to GitHub or Supabase, use browser state or acquire the real assets;
- execute the official CLI or any host executable supplied by a caller;
- select or create a project/target, credential, URL, egress rule, database session or migration
  phase;
- query hosted history, dry-run, apply, repair or pull a database;
- extend or operate the WP-199 journal, authenticate a human or load a production key;
- install a listener, root directory, binary, service, unit, deployment or guarded broker operation;
- stage, activate, stop, start, restart, promote or mutate a live service; or
- update handover/status before reviewed merge and exact-main CI.

## Red-flag screen

- **Shallow module:** cleared. The two callers request sealed custody or one complete proof; internal
  archive, runtime, effect and kernel steps stay hidden.
- **Information leakage:** cleared. No path, argv, environment, pid, target, credential or kernel
  option crosses a callable boundary.
- **Temporal decomposition:** cleared. Provenance and the effect machine each own a full lifecycle.
- **Pass-through methods:** cleared. Adapters accept only closed effects; they do not reproduce the
  public call signature.
- **Shared mutable state:** cleared. Each case owns fresh roots, cgroup, model log and immutable
  result. Cross-case summaries combine only after closure.
- **Synthetic evidence confusion:** cleared by sealed evidence classes, distinct schemas, keys and
  domains, plus the absence of a conversion.
- **Accidental deployability:** cleared by a separate private `rlib`, test-only adapters and static
  reverse-dependency/capability inventory.

## Tradeoffs accepted

- We accept a separate package and independent golden decoder to keep WP-199 ownership and journal
  authority unchanged.
- We accept a substantial Linux-shaped private effect vocabulary to derive exhaustive fault cuts
  from the same order used by the real proof.
- We accept an explicit privileged disposable test container because ordinary cgroup delegation is
  insufficient; its network and mounts remain closed and no production artifact contains an
  adapter.
- We accept Linux/x86-64 specificity because the pinned official release and post-exec proof are
  Linux/x86-64 specific.
- We accept incomplete official runtime identity until separately authorized evidence supplies the
  real runtime base and phase topology.

## Ordered handoff

Implement WP-200 in this order: evidence-class/policy and static boundary; provenance/archive and
ELF verification; independent WP-199 golden verification; pure effect machine and exhaustive model;
real synthetic Linux adapter; then High and Extra-High reviews, blast-radius proof, full CI and PR.

After reviewed merge and exact-main CI, update the rolling handover/status and continue with WP-201's
disposable target-scoped credential, egress, hosted-history and dry-run preparation boundary. Every
external action remains separately and exactly gated.
