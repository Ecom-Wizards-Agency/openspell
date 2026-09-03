# WP-200 — Official CLI custody and synthetic runtime proof

Owner: fixed official-release verification, sealed source/runtime components and disposable
synthetic Linux launcher proofs.

Depends on: merged WP-199 closeout and exact-main CI at
`92696471e2d75d333613348d99a386a67a70506c`.

Architecture: `docs/design/WP-200-ARCHITECTURE.md`.

## Objective

Implement a separate private Rust library that verifies root-anchored pre-opened assets against the
fixed Supabase CLI 2.116.0 facts, safely retains exact source components, parses runtime identity
without executing input and proves one closed synthetic launcher state machine through exhaustive
model cuts and a real disposable Linux adapter.

WP-200 is source/test-only. It has no binary, listener, production kernel adapter, network
acquisition, target, credential, database, Supabase invocation, service, deployment or live-host
operation. The official CLI is never executed.

## Owned files

- `docs/design/WP-200-ARCHITECTURE.md` and this brief;
- new `tools/hosted-migration-runtime-proof/` sources, manifests, wrappers and synthetic fixtures;
- root pnpm lockfile registration; and
- one minimal CI kernel-proof step only if required for the isolated real-Linux proof.

Do not edit `packages/shared`, existing application/database packages, migrations, Supabase
configuration, deployment/service files, WP-198, WP-199 or production operator configuration.
Handover and status change only after reviewed merge and exact-main CI.

## Required behavior

1. Build one Rust `rlib` only. Set `publish = false`, disable automatic binary/example/benchmark
   targets and expose no public Rust item, FFI, npm export, runtime script or reverse dependency.
2. Pin Rust 1.97.1 and the complete Cargo graph. Production modules forbid unsafe code. Any
   unavoidable raw Linux ABI is isolated to one `cfg(test)` module with exact layout/kernel checks.
3. Define sealed `OfficialEvidence` and test-only `SyntheticEvidence` classes with no conversion.
   Compile the exact WP-197 release facts; accept no runtime policy, release, filename, digest,
   archive-rule or destination-layout selection.
4. Accept official input only as already-open descriptors anchored by an already-open filesystem
   root. Revalidate the complete ancestor and object device/inode/mode/uid/gid/link/mount identity
   before and after reads. Accept no caller path or user/agent-owned source.
5. Verify `checksums.txt` and its one exact archive line, the archive size/digest, one gzip member,
   bounded tar structure and exactly two one-level regular entries with fixed GNU-ustar headers,
   archive owners, modes, sizes and digests. Reject concatenation, trailing data, traversal,
   nesting, duplicates, links, sparse/extensions, special files, oversize metadata and
   decompression overrun.
6. Own publication through exclusive fd-relative creation, exact input/output count and byte
   conservation, metadata revalidation, file/directory synchronization, sealed inventory
   publication last and full reopen. Durably consume the destination before source work; a failed
   destination is never repaired or reused. Retain and revalidate exact final root and object
   identities before runtime inspection.
7. Parse ELF64/x86-64, interpreter and `DT_NEEDED` data without invoking `ldd`, a loader, a helper or
   either executable. Resolve both co-located official binaries and the exact known official
   loader/dependency paths only from a supplied root descriptor, verify their immutable identities,
   and require the binary bytes to match the retained source pair. Reject host-backed, writable,
   or unsupported objects. The complete synthetic inventory rejects every extra or substituted
   object; never elevate the digest-incomplete official subset into complete official runtime
   evidence.
8. Do not complete official native-runtime or release-provenance evidence while WP-197's actual
   interpreter/dependency digests and per-phase graph remain unproved. Synthetic evidence cannot
   fill an official field and host facts cannot be inferred as policy.
9. Independently decode and verify an immutable copy of WP-199's exact grant/ticket golden corpus,
   signatures, issuer pin, expiry and repeated bindings. Prove equality with the authoritative
   corpus in tests. Do not import, modify, operate or append to the WP-199 Rust journal.
10. Implement one closed pure state/effect machine for a distinct synthetic proof domain. The
    caller supplies one verified case, not stages, paths, argv, environment, topology, cgroup,
    process or cleanup choices.
11. Persist a synthetic launch intent before any resource-creating effect. Before intent, refusal
    proves zero namespace/cgroup/child/pidfd/resume counts. After intent, any uncertainty remains
    recovery-only and the case is never reusable.
12. Construct one non-cloneable bootstrap permit only after the leader's exact stopped-exec,
    executable/root/map and pre-exec protection boundary is proved. Consume it on the sole fixed
    bootstrap effect. Construct a distinct non-cloneable application-resume permit only after both
    processes' exact stopped-exec, map, cgroup, identity, capabilities, `no_new_privs`, zero-core,
    dumpability and seccomp observations. Consume it on the sole application-resume effect.
13. Derive every model refusal, wrong-result, lost-result and interruption cut from the actual
    successful effect tape. Reconcile offered, accepted, refused, exec, process, pidfd and terminal
    counts exactly.
14. Compile both effect adapters only for tests. `ModelKernel` is deterministic. `LinuxProofKernel`
    uses only fixed synthetic programs and fresh disposable namespaces/cgroup state; no production
    adapter or generic process runner exists.
15. In the real proof, establish private mount/PID/proc/user/IPC/UTS/network namespaces, a child-only
   cgroup-v2 subtree, atomic leader pidfd and descendant pidfds, ptrace fork/vfork/clone/exec custody,
   exact executable/root/maps identity before any post-exec continue and no unexpected process or
   executable. Drop child authority before exec. Permit only the exact object-bound synthetic ELF's
   modeled bootstrap after leader exec/map attestation. Derive the exact permitted static-PIE map
   records from the executable's `PT_LOAD` segments and compare the complete file-backed inventory
   at exec and ready stops.
16. Before bootstrap, prove empty effective/permitted/inheritable/bounding/ambient capabilities,
    `no_new_privs`, zero core limit and the inherited seccomp rule. Because exec resets dumpability,
    the exact fixed executable must reset it before it forks or reaches its ready stop. Repeat the
    pre-bootstrap authority observation for the delegate, prove both complete protected ready
    states, and never issue application resume before both pass.
17. On every real refusal, timeout, tracer death or interruption, prevent application resume where
    applicable, kill/observe every descendant, prove pidfd terminal state and cgroup emptiness, or
    return only recovery/cleanup uncertainty. Exercise real lost-acceptance cuts after every
    resource-creating adapter boundary, after each application-resume syscall, after drain, after
    empty-cgroup observation and after terminal-proof persistence. Reject a real unexpected
    post-resume event. PID text is never authority; the tracer-death parent independently retains
    both descendant pidfds before killing the tracer in stopped, mixed-resume and fully resumed
    states, with fixed pipe evidence that the latter two states actually returned from their ready
    stops.
18. Run the real proof only through an explicit wrapper. Build, verify and hash one opened test ELF,
    copy that exact descriptor-owned object into a local content-addressed image derived from the
    pinned Rust image, independently rehash the in-image object, then run only that immutable image
    ID with private cgroup namespace, no network, read-only root, fresh tmpfs and no repository,
    user-directory, credential, browser, Docker-socket or service mount. Never skip a missing kernel
    invariant. Never run pull-request-controlled code in the privileged proof container; CI may run
    it only in a dedicated permissionless job for trusted `main` revisions after ordinary checks
    pass.
19. Return only bounded summaries or fixed nonsensitive refusals. Do not echo source bytes, paths,
    environments, pids, signatures, target-like canaries or nested OS errors in results/logs.
20. Static source, Cargo/rustdoc/npm and reverse-dependency tests must prove the production package
    has no public API, binary, process/namespace/cgroup/socket/network/database/Supabase/credential/
    service/deployment capability or arbitrary input surface.

## Proof requirements

- exact fixed release constants and canonical evidence field order;
- positive synthetic two-entry archive retention with offered/parsed/published/reopened count,
  bytes and digest equality;
- complete checksum/gzip/tar/path/type/size/digest/trailing-data/decompression adversarial matrix;
- descriptor, ownership, mode, link, mount, ancestor and replacement races plus publication/sync
  fault cuts;
- ELF format, architecture, linkage, interpreter, dependency and complete inventory matrix;
- compile-time and runtime synthetic/official non-confusion;
- independent WP-199 golden agreement and one-field mutation refusal;
- complete legal transition table and derived model cut coverage;
- real namespace, cgroup, pidfd, ptrace/exec-map, topology, capability, core, dumpability and seccomp
  assertions with no skip;
- exact no-residue proof after success and every real failure case;
- privacy-canary proof across results, errors and logs;
- pinned Cargo format/check/clippy/rustdoc/test plus TypeScript boundary tests;
- repository typecheck, lint, test and hygiene on exact PR head, plus the permissionless privileged
  kernel job on the merged exact-main revision; and
- one independent High correctness review and two Extra-High authority/kernel/crash reviews.

## Explicit exclusions

WP-200 does not:

- download/authenticate to GitHub or Supabase or use browser authentication;
- execute the official CLI, connect to a target or use a credential;
- query history, dry-run, apply, repair, pull or create a database/project;
- create a production journal transition, signer, listener, launcher, service or deployment;
- stage, activate, restart, promote or mutate live infrastructure; or
- update rolling status/handover before reviewed merge and exact-main CI.

## Ordered handoff

Commit the architecture and brief before implementation. Implement policy/boundary first, then
provenance/archive/ELF, WP-199 golden verification, the effect machine/model and finally the real
kernel adapter. Close High and Extra-High review findings before full CI and PR.

After merge and exact-main CI, reconcile handover/status and continue with WP-201's disposable
target-scoped credential, egress, hosted-history and dry-run preparation boundary. Every external
action remains separately and exactly gated.
