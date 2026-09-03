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
  `3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4`, archive owner
  `1001:1001`, mode `0755` and header SHA-256
  `bcfc0395fada1a7a6118aa194a046a83f8fd917833ff030a8cb705c98cbf8c7d`; and
- `supabase-go`, 43,892,898 bytes, SHA-256
  `1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1`, archive owner
  `1001:1001`, mode `0755` and header SHA-256
  `137ad9282585686605175d9e88927c551a90e7a07ca8bc48a93940ce48facaf7`.

There is no runtime policy injection. Tests use a sealed `SyntheticEvidence` policy with small
fixtures through the same parsing and publication engine. The result type preserves its evidence
class and cannot become `RetainedRelease<OfficialEvidence>`.

### Input admission

`RootAnchoredPair<C>` consumes descriptors for one fresh intake root and exactly two regular files.
The private constructor records a root-to-leaf ancestor walk from an already-open filesystem-root
descriptor and requires every component to be owned by the expected root identity, not writable by
group or other, not a symlink, not a mount crossing and stable by device/inode/mode/uid/gid before
and after each read. Both assets require one link, exact size and stable metadata. The intake root
contains exactly those two assets. The transaction records the exact WP-197
`openspell.supabase-official-source.v1` canonical leaf and its root-to-source ancestor-walk digest;
synthetic evidence uses a distinct schema and cannot satisfy an official field.

WP-200 does not download the assets. A future attended helper may supply official handles only after
its separately authorized fixed transport has completed. Agent-produced, user-owned, package-cache
or path-only input cannot enter the official constructor.

### Archive transaction

The transaction is one deep operation:

1. stream and hash the checksums asset under a fixed bound;
2. require exactly one canonical line naming the pinned archive and digest;
3. stream and hash one gzip member, refusing concatenated or trailing compressed data;
4. parse bounded 512-byte tar headers internally, accepting only the pinned official GNU-ustar
   representation or the fixed synthetic POSIX-ustar representation;
5. accept exactly the two one-level regular files in sorted inventory order with fixed header,
   owner, mode, size and content digests;
6. refuse links, sparse/PAX/GNU extensions, devices, FIFOs, sockets, duplicate or nested names,
   absolute paths, traversal, extra entries, oversized metadata and unconsumed data;
7. durably consume the fresh destination with an exclusive fixed reservation before any source
   read, then write fixed names using exclusive fd-relative creation;
8. verify count, byte and digest conservation, sync each file and directory, then publish one sealed
   inventory last; and
9. atomically rename the synced reservation into the sealed inventory, reopen the exact same
   objects and revalidate every retained identity and byte before returning.

Failure consumes the destination and never returns a reusable object. Production does not delete,
repair, overwrite or retry an ambiguous partial tree. Disposable tests remove only their own outer
laboratory after all handles close.

## Runtime components

The ELF verifier parses bytes; it never uses `ldd`, a loader or an executable:

- exact ELF64/x86-64 headers, program headers, interpreter and dynamic sections;
- the statically linked delegate;
- the exact official `PT_INTERP` and ordered `DT_NEEDED` names, plus descriptor-relative resolution
  of every currently specified loader/dependency path within one supplied root;
- the exact two co-located root-image binary paths, whose bytes must match the retained official
  source pair before any component result exists;
- modes, owners, link counts, mounts, sizes, stable descriptor identities and computed digests for
  those known official objects; and
- rejection of host-backed paths, writable objects and unsupported features; exact unknown-map,
  extra-file and dependency-substitution rejection in the complete synthetic proof.

The synthetic root has a fixed complete inventory and rejects every extra or substituted object.
The raw 2.116.0 `DT_NEEDED` order is `libc.so.6`, `ld-linux-x86-64.so.2`,
`libpthread.so.0`, `libdl.so.2`, `libm.so.6`; the separately bound loader entry is resolved once and
is not duplicated in WP-197's four-entry canonical dependency array.
WP-197 does not yet contain the official interpreter/dependency digests, the complete runtime-image
inventory or the measured per-phase front-controller/delegate graph. WP-200 therefore cannot emit a complete official
`nativeRuntimeIdentitySha256` or `releaseProvenanceSha256`. It returns only typed official runtime
components marked incomplete even after the known paths resolve. Synthetic fixtures can complete a synthetic identity and exercise every rule. Filling
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
  -> leader exec stop, identity and maps attested
  -> one-use bootstrap permit consumed
  -> fixed bootstrap establishes descendant custody and both protected ready stops
  -> one-use application-resume permit consumed
  -> descendants drained
  -> child terminal and cgroup empty
  -> durable synthetic terminal proof
```

The transition reducer emits one closed `Effect` enum. Only the expected observation can advance
the state. An effect failure before the durable launch intent returns a fixed refusal with exact zero
resource counts. Any failure or uncertainty after that intent returns `recovery_required`; it cannot
rewind, mint another resume permit, declare cleanup successful or run the case again.

After the tracer verifies the initial stopped namespace, the child loses all capabilities and
installs `no_new_privs`, zero-core, dumpability and seccomp protections immediately before exec.
The one-use `BootstrapPermit` is constructed only after the leader's exact exec object, root and map
inventory plus its preserved zero-capability, `no_new_privs`, zero-core and seccomp boundary match.
It authorizes only the fixed object-bound bootstrap that resets exec-time dumpability before any
fork, creates the delegate and takes both processes to their protected ready stops. A distinct
one-use `ResumePermit` is constructed only after both exec, map, cgroup, uid/gid, capability,
`no_new_privs`, core-limit, dumpability and seccomp observations match. It is consumed by the single
application-resume effect. This makes both bootstrap and application release structural rather than
a test-order convention.

Every effect declares whether it may create a namespace, cgroup, child, pidfd or resumed process.
The machine reconciles offered effects, accepted effects, refused effects, observed execs, pidfds,
children, descendants and terminal resources exactly. An accepted effect whose response is wrong or
lost contributes its complete declared resource vector to a separate `uncertain_resources` ledger;
it never publishes false zeroes or promotes uncertain terminal state into observed resources.

## Model proof

`ModelKernel` records one successful effect tape, then derives every reachable refusal, lost-result,
wrong-result and interruption cut from that tape. The test does not maintain a parallel handwritten
fault-point list.

For every cut it proves:

- no effect occurs before its required durable predecessor;
- a pre-intent failure has zero namespace/cgroup/child/pidfd/resume counts;
- a post-intent failure remains recovery-only;
- an uncertain child or cgroup is never counted as terminal;
- no bootstrap or application resume occurs without consuming its distinct one-use permit;
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
- a statically linked PIE proof executable, with the exact permitted file-map records derived from
  its `PT_LOAD` segments and compared at each exec stop before that process can continue;
- removal of the child capability, privilege, core-dump and dumpability authority immediately before
  exec, with the zero-capability, `no_new_privs`, zero-core and seccomp boundary re-attested at each
  exec stop;
- one permit-bound fixed bootstrap after the exact leader exec/map stop, with no application input
  or authority and an exact protected ready stop for both processes;
- retained executable identity, namespace-root identity and the same exact map inventory again at
  each ready stop before application resume;
- empty effective, permitted, inheritable, bounding and ambient capability sets;
- `PR_SET_NO_NEW_PRIVS`, core limit zero and dumpability reset to zero after each exec;
- rejection of a later nonzero dumpability change by the installed seccomp policy; and
- a real bounded kernel wait deadline, explicit unexpected-post-resume-event refusal and injected
  lost-acceptance cuts after every resource-creating adapter boundary, each resume syscall, drain,
  empty-cgroup observation and terminal-proof persistence; and
- pidfd terminal observation, direct-child reaping and an empty cgroup after success, refusal,
  timeout, interruption, unexpected events and adapter faults; tracer death additionally proves
  terminality through independently retained descendant pidfds in stopped, mixed-resume and
  fully-resumed cuts, with fixed `D`/`D+L` pipe evidence that resumed tracees returned from their
  ready stops before the tracer died.

An unexpected process, exec, mapping, identity or protection result consumes no resume permit,
kills the complete child cgroup and remains recovery-only unless terminal/empty observations are
conclusive. PID text is evidence only; it is never an authority handle and is not reopened after
its pidfd reports exit. The tracer-death parent receives a bounded fixed-format witness, opens and
holds independent leader and delegate pidfds, verifies their start identities and exact cgroup
membership before killing the tracer, then proves all three pidfds terminal.

### Disposable proof container

The ordinary package test runs the model, provenance, parsing and static boundary suites without
privilege. A separate `test:kernel` wrapper:

1. creates an unprivileged build container with an anonymous `/target` volume, captures its immutable
   container ID from the isolated Docker client's exact response and the immutable anonymous-volume
   identity from that container, and builds the one synthetic kernel-test executable with the pinned
   Rust toolchain and locked graph without creating a mutable host build tree;
2. extracts the compiler-reported object from that stopped container ID as one bounded, strictly
   parsed archive, validates and hashes the exact static-PIE bytes in memory, copies those bytes into
   a separate stopped staging container and commits it to a content-addressed local image;
3. independently rehashes the in-image executable and addresses all later executions only by the
   immutable image ID;
4. starts that exact image with a private cgroup namespace, `--network none`, read-only
   root, fresh tmpfs state and no repository, user directory, credential, browser, Docker socket or
   service mount;
5. enters the disposable container through pinned `setpriv`, retaining only `CAP_SYS_ADMIN` and
   `CAP_SETFCAP` for namespace and identity-map construction before the child proves an empty
   capability set; and
6. requires the exact executable to report all 19 cases and counts, rehashes the immutable image
   afterwards, then proves every case container, staging object, local image and anonymous build
   volume absent. Container/image deletion uses only captured immutable IDs; the captured anonymous
   volume identity is verified absent after the exact container's `--volumes` removal and is never
   separately deleted by the production wrapper. Names and tags are absence diagnostics, never
   cleanup authority.
   For every interruption cut, the test-only shim writes the exact container/image IDs taken from
   the actual create, commit or inspect response into a mode-0600 file under its private cut
   directory before publishing readiness. Running-case and final-image-deletion cuts use that same
   response-bound identity channel; prefix and tag queries never supply adoption or cleanup
   authority. The harness promotes each response ID into cleanup custody before attempting Docker
   inspection. If inspection cannot capture anonymous-volume identity, exact container removal with
   `--volumes` must restore the complete pre-spawn volume inventory; the exact response-bound image
   ID remains independently removable.
   Docker mutation clients run in separate process
   groups so a wrapper process-group SIGINT/SIGTERM cannot sever an in-flight daemon response before
   its ID is retained. Any independent client timeout or malformed response without an ID is
   permanently cleanup-uncertain even when its name/tag is momentarily absent. Signals are recorded
   and refused at event-loop checkpoints before any following start or commit, and the wrapper emits
   no success summary until final image cleanup has been proved. A separate real interruption harness
   interposes a fixed test-only Docker client shim that holds successful build-container and
   committed-image responses before returning their immutable IDs. It signals while each response is
   held and holds a case-inspection response to prove cancellation before privileged start. For the
   running cut, the shim substitutes one fixed external-interruption hold mode into the selected
   timeout-case create request, verifies the response-bound container is running that exact mode and
   kills only that exact ID after the wrapper signal has been sent. A private fixed-fd phase pipe
   proves that the wrapper observed each signal. The same pipe publishes `cases-complete` only after
   all 19 cases and the final artifact verification succeed, so the final image-deletion cut cannot
   pass on a failure-path deletion. Every cut verifies the captured container, image and
   anonymous-volume IDs are all absent. The harness installs its child
   error/close observer immediately, starts the child-exit deadline only after the tested signal,
   gives setup and final-deletion observation the composed operation budget, and awaits its Docker
   event watcher. A watchdog-forced wrapper exit always disqualifies the cut and transfers emergency
   cleanup custody to the harness: it may remove only the already captured immutable container ID
   with `--volumes` and derived-image ID, then must prove the captured anonymous-volume name absent
   before refusing. A volume name is evidence, never independent deletion authority; if exact
   container removal cannot establish its absence, cleanup remains uncertain.
   Emergency Docker clients are asynchronously owned process groups. Each operation reserves time
   inside one monotonic cleanup deadline for TERM and KILL settlement; no synchronous client timeout
   can extend that deadline. Fixed uninspected container/image recovery and a TERM-resistant child
   prove response-ID fallback cleanup and forced client closure through the same bounded ownership
   path.
   A fixed watchdog fixture exercises that disqualifying path with an inert, networkless,
   read-only container, anonymous volume and disposable derived image, forces the unresponsive
   fixture supervisor to close through the same custody function used by every real cut, then proves
   exact container/image cleanup and captured-volume absence. Fixture setup retains a valid
   container ID before validating the create response; if inspection cannot capture the volume
   name, teardown must restore the complete pre-create volume inventory or refuse.

The reviewed image is:

```text
docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
```

The wrapper refuses when Docker, cgroup v2, required namespace/ptrace behavior or exact cleanup is
unavailable. It never silently skips. The trusted proof workflow never fetches or executes a
pull-request-controlled revision in its privileged proof container. A separate default-branch
`workflow_run` workflow runs the proof only after ordinary CI succeeds for a trusted `main` push.
That workflow uses commit-pinned setup actions and bounds every fetch, setup, install and image
acquisition step before invoking the strict wrapper. It explicitly acquires the exact digest-pinned
builder image, so a fresh runner cannot
turn Docker's otherwise implicit image-pull output into an ambiguous container-create response.
Each wrapper resolves that retained reference to one exact local image ID before mutation and every
container create uses `--pull=never`; the interruption wrapper performs its inspection through the
same asynchronously owned TERM/KILL-bounded client path as the rest of its deadline-sensitive
operations, inside its fixed refusal handler. Image acquisition and isolated compilation are separate from
the privileged proof cases, which remain networkless. The workflow's proof and job ceilings retain
15 minutes of job-level headroom beyond the sum of every step ceiling, while the proof ceiling
retains headroom beyond the longest 60-to-65-minute observation/response hold and its
forced-settlement reserve. The platform therefore cannot preempt the wrapper's cleanup custody
before one of those independently bounded steps has already failed the proof.
The trusted workflow has no manual or pull-request trigger, no permissions or
persisted checkout credential, fetches and verifies the triggering exact SHA, points pnpm setup at
that checked-out manifest and runs the proof as its final step. A local operator can run the wrapper
explicitly; ordinary local repository tests do not silently start a privileged container.

This guarantee is scoped to the trusted proof workflow and its container. General pull-request CI
executes untrusted repository code on GitHub-hosted runners under the repository's existing
organization policy; WP-200 neither treats that runner as a security sandbox nor changes its
Docker/sudo policy.

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
    machine.rs             pure state/effect reducer and distinct one-use bootstrap/resume permits
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
    docker-response-shim.mjs  test-only bounded response hold for deterministic signal cuts
    kernel-proof.mjs
    kernel-proof-interruption.mjs
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
- package checks, repository CI and public hygiene on the exact PR head, followed by the isolated
  privileged kernel proof on the merged exact-main revision; and
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
  insufficient; its network and mounts remain closed, it receives no repository or credential
  mount, it runs only in a credential-free trusted-main CI job, and no production artifact contains
  an adapter.
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
