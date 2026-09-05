# WP-201 architecture: disposable hosted preparation without apply

Status: selected for implementation on 2026-09-04.

Reconciled base: `origin/main` at `560d5e28615ea023f020f1a3d0944dff96213981`.

## Outcome

WP-201 adds one private preparation-only coordinator for a separately authorized disposable
Supabase target. It can prove two phases only:

1. exact hosted migration-history fetch at the reviewed 41-file prefix; and
2. exact `db push --dry-run` presentation of the five reviewed suffix migrations.

The coordinator has no apply phase, apply ticket, apply argv, write approval, deployment artifact,
service, listener or production target. Its successful result is a closed, non-authorizing
observation. It never produces a reusable readiness token or carries live custody into WP-202.

Source behavior and proof execution are completely synthetic, credential-free and offline. The
networked dependency-acquisition operation described below is setup rather than proof evidence;
the checksum-locked vendored dependency bytes it produces are explicit, immutable build inputs. This
document authorizes only that source slice. It deliberately contains no live external adapter. The
external work is ordered: a reviewed read-only discovery-policy addendum; one separately authorized
disposable discovery run; a reviewed adapter-candidate architecture addendum; the exact inert,
ignored adapter candidate staged under the compiled deny-live policy; reproducible offline
measurement of those fixed bytes; and a reviewed final executable-policy addendum that pins the
candidate and observed protocol before any one-use execution capability exists. No official asset,
target or credential is touched before the discovery policy, and no adapter candidate is written
before discovery evidence and its architecture addendum. The candidate cannot obtain a network or
secret capability until the final policy has merged; that activation changes no pinned adapter or
runtime byte. Each external run requires fresh disposable-only authorization. If target scope,
credential split, gateway behavior, lossless session evidence or official runtime identity cannot
be proved, the live proof stops; broad credentials and weaker observation are not fallbacks.

WP-201 neither calls Amazon nor changes the product's Amazon-write state. The product direction
remains that synced profiles are manageable, first write requires explicit profile activation, and
approved supported batches later apply through the worker directly to Amazon.

## Reconciled starting point

- WP-197 deterministically builds and independently verifies the exact 41-plus-five migration
  artifact. The 41-file baseline is 279,677 bytes with ledger digest
  `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea`; the 46-file artifact is
  646,628 bytes with ledger digest
  `baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`.
- WP-198 is a pure independent oracle for supplied private evidence and transcripts. It exposes no
  launcher, credential or external authority.
- WP-199 owns the private v1 root journal, fixed nonmultiplexed IPC codecs and one-use grant/ticket
  transitions. Its v1 parser intentionally treats unknown transitions as recovery-only.
- WP-200 implements fixed official-release policy and descriptor-only verification, but its
  official runtime result remains incomplete. Its complete Linux launcher proof is synthetic and
  test-only. It exposes no production launcher or external target.
- The last authenticated hosted-ledger verification was the 41-file prefix through
  `20260901010000`. The five suffix migrations remain source-only.
- Production web and MCP revisions remain behind source, both new worker units remain absent and
  the legacy worker has no revision stamp. WP-201 does not alter any of those facts.

## Candidate comparison

Three independently developed designs were compared.

### Extend only the WP-200 crate

This minimizes packages and reuses descriptor/runtime code, but it either creates a second root
journal or substitutes a test signer for the authority that must own a real disposable operation.
That proves an isolated model, not composition with the accepted root custody boundary.

### Build a third clean-room runtime and journal

This avoids widening prior crates, but duplicates canonicalization, durable transition semantics,
archive/ELF verification and cleanup authority. Two implementations could each pass their own
tests while disagreeing on the live operation.

### Selected: thin coordinator, byte-only handoffs, one shared registry and narrow bridges

The selected design adds one private coordinator crate, a fresh preparation-journal v2 inside the
existing root-authority crate, one state-root registry shared by v1 and v2, and one feature-gated
runtime bridge inside the existing runtime-proof crate. Cross-package handoffs are bounded canonical
bytes plus standard owned descriptors, not a new shared runtime type package. It accepts the
unavoidable Rust visibility widening explicitly and constrains it:

- both bridges are behind a non-default `wp201-internal` feature;
- bridge capability types are sealed, non-cloneable and constructible only from pre-opened owned
  descriptors or exact root-held permits;
- all three crates remain `publish = false`, library-only and have no default feature;
- exactly one reviewed reverse dependency may enable each bridge: the WP-201 coordinator;
- static tests reject an application, service, deployment or second tool dependency; and
- the security boundary is the owned descriptor/permit, not Rust visibility alone.

Each consumer independently parses the documented bytes and cross-checks the shared golden corpus,
as WP-198/WP-200 already do. This avoids editing the frozen `packages/shared` contract or creating a
second cross-package contract authority. Bytes confer no authority without separately held,
policy-pinned keys and descriptors.

The v2 journal has a new magic, schema, signature domain and authority root. It never appends a new
record to, parses as, repairs or automatically upgrades a v1 journal. The existing storage engine is
made format-parameterized only behind crate-private traits; golden and crash tests must prove every
existing v1 byte and recovery result remains unchanged. A root-owned registry outside both journal
inventories supplies the one state-root OFD super-lock and target-generation compare-and-set. v1
and v2 therefore cannot operate independently on the same host or target.

## Ownership and dependency shape

WP-201 may edit only:

```text
docs/design/WP-201-ARCHITECTURE.md
docs/workpackages/WP-201-disposable-preparation-proof.md
tools/hosted-migration-root-authority/
  Cargo.toml
  Cargo.lock
  README.md
  scripts/cargo.mjs
  src/lib.rs
  src/boundary.test.ts
  src/journal.rs
  src/journal/storage.rs
  src/authority_registry.rs
  src/authority_registry_tests.rs
  src/super_lock.rs
  src/cross_version_tests.rs
  src/preparation_v2.rs
  src/preparation_v2_tests.rs
  src/preparation-policy-v1.golden.json
  src/preparation-ticket-v2.golden.json
tools/hosted-migration-runtime-proof/
  Cargo.toml
  Cargo.lock
  README.md
  src/lib.rs
  src/boundary.test.ts
  src/linux_abi.rs
  src/linux_kernel_tests.rs
  src/machine.rs
  src/kernel_custody.rs
  src/wp201_bridge.rs
  src/wp201_bridge_tests.rs
  fixtures/preparation-policy-v1.golden.json
tools/hosted-migration-preparation-proof/
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  package.json
  tsconfig.json
  scripts/cargo.mjs
  scripts/acquisition-archive.mjs
  scripts/docker-integration.mjs
  scripts/docker-event-helper.mjs
  scripts/interruption-harness.mjs
  scripts/path-cleanup-helper.mjs
  scripts/proof-engine.mjs
  scripts/test.mjs
  src/lib.rs
  src/canonical.rs
  src/policy.rs
  src/records.rs
  src/machine.rs
  src/journal_adapter.rs
  src/runtime_adapter.rs
  src/credential.rs
  src/egress.rs
  src/gateway.rs
  src/observer.rs
  src/history.rs
  src/dry_run.rs
  src/interruption.test.ts
  src/model_tests.rs
  src/adversarial_tests.rs
  src/boundary.test.ts
  src/composition.test.ts
docs/design/wp201-controller-fixtures/
  acquisition-controller.sh
  proof-controller.sh
  fixtures/preparation-v2.golden.json
pnpm-lock.yaml
```

For an operator-requested capacity/continuation checkpoint only, the coordinator may also update
`docs/HANDOVER.md` and correct stale `docs/PLAN.md` prose solely to align it with
already-authoritative `AGENTS.md` in one standalone documentation commit. That exception records
verified state and open work only; it cannot create or change a product, implementation or security
requirement, claim WP-201 acceptance or completion, update `docs/STATUS.md`, satisfy any
source-acceptance row or authorize an external action.

The source slice does not add or edit an external adapter, production launcher or wrapper. A later
adapter-candidate architecture addendum must name its exact ignored path, deny-live construction
boundary and expanded ownership before that file exists. The separately reviewed final policy can
then pin the already staged, measured candidate rather than predicting future bytes.
The implementation does not edit `packages/shared`, applications, migrations, Supabase
configuration, WP-197/WP-198 sources, deployment files, services or status. Apart from the narrow
operator-requested continuity exception above, status and handover change only after a reviewed
merge and exact-main CI.

Dependency direction is fixed:

```text
preparation-proof -> hosted-migration-root-authority
preparation-proof -> hosted-migration-runtime-proof
```

Arrows mean “depends on.” Both bridge features are non-default. Neither prior crate depends on the
coordinator. No application depends on any of the three.

## Agent-safe and internal interfaces

The future agent-facing broker vocabulary remains exactly:

```text
prepare()
status(operation_id)
reconcile(operation_id)
```

It accepts no target, phase, path, argv, environment, URL, endpoint, credential, SQL, timeout,
retry, dry-run flag or write selector. WP-201 does not add that broker or any listener; it fixes the
coordinator contract the future broker may call.

The canonical record families below are byte protocols, not shared Rust types. The two bridge
crates independently parse them and compare the same golden bytes. Bridge-local bounded byte
wrappers expose only `as_slice()` and fixed-size signature accessors; the coordinator never passes a
root-crate capability into the runtime crate.

Unless a field contract says otherwise, canonical JSON in WP-201 is UTF-8, uses the stated key
order, two-space indentation, no insignificant whitespace inside scalar values, and exactly one
terminal line feed. Objects reject duplicate, missing, reordered or unknown keys; strings reject
control characters and noncanonical escapes; integers use their shortest decimal spelling.

The root-authority bridge is exactly:

```rust
#[cfg(feature = "wp201-internal")]
#[doc(hidden)]
pub mod wp201_internal {
    pub struct InstalledPreparationRootPolicyV1 { /* sealed, non-Clone */ }
    pub struct PreparationBootstrapLeaseV1 { /* sealed, non-Clone; owns policy/shared lock */ }
    pub struct FreshPreparationStateRootV1 { /* sealed; exact empty v2 journal only */ }
    pub struct ActivePreparationStateRootV1 { /* sealed; exact one nonterminal operation only */ }
    pub struct ClosedPreparationStateRootV1 { /* sealed, non-Clone; read-only terminal root */ }
    pub enum StateRootInstallationOutcomeV1 {
        Installed(FreshPreparationStateRootV1),
        CommitOutcomeUnknown,
    }
    pub struct RegisteredPreparationAuthorityV2 { /* sealed, non-Clone */ }
    pub struct RecoveryPreparationAuthorityV2 { /* sealed, non-Clone; no normal advancement */ }
    pub struct EffectIntentHandleV1 { /* sealed, non-Clone */ }
    pub struct ClassifiedEffectHandleV1 { /* sealed, non-Clone */ }
    pub struct EvidenceChannelReceiptV1 { /* sealed, one-record */ }
    pub struct PreparedTicketHandleV2 { /* sealed, non-Clone */ }
    pub struct ExecutingGrantV2 { /* sealed, non-Clone */ }
    pub struct TerminalCommitTokenV2 { /* sealed, non-Clone */ }
    pub struct TerminalReceiptV2 { /* sealed, non-Clone */ }
    pub struct ObservationCoreReceiptV1 { /* sealed, non-Clone */ }
    pub struct ClosedJournalReaderV2 { /* read-only, sealed, non-Clone */ }
    pub struct BoundedStatusBytes { /* at most 16,384 bytes */ }
    pub struct BoundedClosedReceiptBytes { /* at most 16,384 bytes */ }
    pub struct BoundedObservationBytes { /* at most 16,384 bytes */ }

    pub fn inspect_installed_preparation_policy(policy: std::os::fd::OwnedFd)
        -> Result<InstalledPreparationRootPolicyV1, PreparationRefusal>;
    pub fn inspect_preparation_bootstrap(policy: InstalledPreparationRootPolicyV1,
        synthetic_proof_bootstrap_root: std::os::fd::OwnedFd)
        -> Result<PreparationBootstrapLeaseV1, PreparationRefusal>;
    pub fn install_preparation_state_root(bootstrap: PreparationBootstrapLeaseV1,
        empty_state_root: std::os::fd::OwnedFd,
        registry_signing_key: std::os::fd::OwnedFd,
        trusted_clock_procfs_root: std::os::fd::OwnedFd,
        installation_authorization_bytes: &[u8],
        installation_authorization_signature: &[u8; 64])
        -> Result<StateRootInstallationOutcomeV1, PreparationRefusal>;
    pub fn inspect_fresh_preparation_state_root(bootstrap: PreparationBootstrapLeaseV1,
        state_root: std::os::fd::OwnedFd)
        -> Result<FreshPreparationStateRootV1, PreparationRefusal>;
    pub fn inspect_active_preparation_state_root(bootstrap: PreparationBootstrapLeaseV1,
        state_root: std::os::fd::OwnedFd,
        operation_sha256: [u8; 32])
        -> Result<ActivePreparationStateRootV1, PreparationRefusal>;
    pub fn inspect_closed_preparation_state_root(bootstrap: PreparationBootstrapLeaseV1,
        state_root: std::os::fd::OwnedFd,
        operation_sha256: [u8; 32])
        -> Result<ClosedPreparationStateRootV1, PreparationRefusal>;
    pub fn open_preparation_authority(state_root: FreshPreparationStateRootV1,
        signing_key: std::os::fd::OwnedFd,
        credential_broker_control: std::os::fd::OwnedFd,
        trusted_clock: std::os::fd::OwnedFd,
        entropy: std::os::fd::OwnedFd,
        authorization_bytes: &[u8], authorization_signature: &[u8; 64])
        -> Result<RegisteredPreparationAuthorityV2, PreparationRefusal>;
    pub fn reopen_active_preparation_authority(state_root: ActivePreparationStateRootV1,
        signing_key: std::os::fd::OwnedFd,
        credential_broker_control: std::os::fd::OwnedFd,
        trusted_clock: std::os::fd::OwnedFd,
        authorization_bytes: &[u8], authorization_signature: &[u8; 64])
        -> Result<RecoveryPreparationAuthorityV2, PreparationRefusal>;
    pub fn reopen_closed_authority(state_root: ClosedPreparationStateRootV1,
        retained_bundle_root: std::os::fd::OwnedFd,
        operation_sha256: [u8; 32])
        -> Result<ClosedJournalReaderV2, PreparationRefusal>;

    impl RegisteredPreparationAuthorityV2 {
        pub fn begin_effect(&mut self, effect_code: u8, request_bytes: &[u8],
            recovery_anchor_fds: Vec<std::os::fd::OwnedFd>)
            -> Result<EffectIntentHandleV1, PreparationRefusal>;
        pub fn begin_recovery_cleanup(&mut self, release_effect_code: u8,
            recovery_anchor_fds: Vec<std::os::fd::OwnedFd>)
            -> Result<EffectIntentHandleV1, PreparationRefusal>;
        pub fn authenticate_evidence_channel(&self,
            channel: std::os::fd::OwnedFd, producer_code: u8)
            -> Result<EvidenceChannelReceiptV1, PreparationRefusal>;
        pub fn record_accepted(&mut self, intent: EffectIntentHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<ClassifiedEffectHandleV1, PreparationRefusal>;
        pub fn record_no_accept(&mut self, intent: EffectIntentHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<ClassifiedEffectHandleV1, PreparationRefusal>;
        pub fn acquire_and_queue_credential(&mut self, intent: EffectIntentHandleV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn reconcile_credential(&mut self, effect_code: u8)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn release_gateway_and_observer(&mut self, intent: EffectIntentHandleV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn close_effect(&mut self, effect: ClassifiedEffectHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn issue_ticket(&mut self, phase_bindings_bytes: &[u8])
            -> Result<PreparedTicketHandleV2, PreparationRefusal>;
        pub fn mark_executing(&mut self, ticket: PreparedTicketHandleV2)
            -> Result<ExecutingGrantV2, PreparationRefusal>;
        pub fn commit_terminal(&mut self, token: TerminalCommitTokenV2,
            terminal_bytes: &[u8], terminal_signature: &[u8; 64])
            -> Result<TerminalReceiptV2, PreparationRefusal>;
        pub fn commit_terminal_no_spawn(&mut self, ticket: PreparedTicketHandleV2,
            zero_bytes: &[u8], zero_signature: &[u8; 64])
            -> Result<TerminalReceiptV2, PreparationRefusal>;
        pub fn status(&self, operation_sha256: [u8; 32])
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn reconcile(&mut self, operation_sha256: [u8; 32],
            channel: EvidenceChannelReceiptV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn commit_observation_core(&mut self, observation_core_bytes: &[u8])
            -> Result<ObservationCoreReceiptV1, PreparationRefusal>;
        pub fn close_no_apply(self, core: ObservationCoreReceiptV1,
            conservation_bytes: &[u8])
            -> Result<BoundedClosedReceiptBytes, PreparationRefusal>;
    }

    impl RecoveryPreparationAuthorityV2 {
        pub fn begin_recovery_cleanup(&mut self, release_effect_code: u8,
            recovery_anchor_fds: Vec<std::os::fd::OwnedFd>)
            -> Result<EffectIntentHandleV1, PreparationRefusal>;
        pub fn authenticate_evidence_channel(&self,
            channel: std::os::fd::OwnedFd, producer_code: u8)
            -> Result<EvidenceChannelReceiptV1, PreparationRefusal>;
        pub fn record_accepted(&mut self, intent: EffectIntentHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<ClassifiedEffectHandleV1, PreparationRefusal>;
        pub fn record_no_accept(&mut self, intent: EffectIntentHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<ClassifiedEffectHandleV1, PreparationRefusal>;
        pub fn close_effect(&mut self, effect: ClassifiedEffectHandleV1,
            channel: EvidenceChannelReceiptV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn reconcile_credential(&mut self, effect_code: u8)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn status(&self, operation_sha256: [u8; 32])
            -> Result<BoundedStatusBytes, PreparationRefusal>;
        pub fn reconcile(&mut self, operation_sha256: [u8; 32],
            channel: EvidenceChannelReceiptV1)
            -> Result<BoundedStatusBytes, PreparationRefusal>;
    }

    impl PreparedTicketHandleV2 {
        pub fn canonical_bytes(&self) -> &[u8];
        pub fn signature(&self) -> &[u8; 64];
    }
    impl EffectIntentHandleV1 {
        pub fn canonical_bytes(&self) -> &[u8];
        pub fn signature(&self) -> &[u8; 64];
    }
    impl ExecutingGrantV2 {
        pub fn ticket_bytes(&self) -> &[u8];
        pub fn ticket_signature(&self) -> &[u8; 64];
        pub fn executing_bytes(&self) -> &[u8];
        pub fn executing_signature(&self) -> &[u8; 64];
        pub fn into_terminal_token(self) -> TerminalCommitTokenV2;
    }
    impl ClosedJournalReaderV2 {
        pub fn derive_observation_and_close(self)
            -> Result<BoundedObservationBytes, PreparationRefusal>;
    }
}
```

For this source-only slice, `inspect_installed_preparation_policy` accepts one root-owned descriptor
and compares its complete synthetic-deny canonical bytes to the crate's compile-time SHA-256 before
parsing the root issuer key, clock/entropy identities, runtime-custodian key and executable-policy
digest. No journal, authorization or caller field selects that fixture digest. This constructor is
not the future external trust path. The descriptor must have `FD_CLOEXEC`, be opened read-only, and
identify one root-owned mode-`0600`, link-count-one, 2,508-byte regular file. It is consumed on every
outcome and read to exact EOF with offset-independent `pread`. The root and runtime source golden
copies are byte-identical canonical JSON whose SHA-256 is exactly
`692216120478fce4caa82e569767ec872b36ec7fccbf4c9430eb7f11e433fcdb`:

```json
{
  "schemaVersion": "openspell.preparation-installed-root-policy.v1",
  "policyClass": "synthetic_deny_live",
  "sourceRevision": "0000000000000000000000000000000000000000",
  "proofBootstrapVerifierIdentitySha256": "78d763e84d10a60c977a5b897c00907abebc4b5d164fa2f97b97338182d4d477",
  "proofBootstrapManifestSha256": "8f6f509889310fb71ea2422be4278ae30ac318e37964c532bccc1054b09c176c",
  "proofBootstrapActivationPublicKeyHex": "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737",
  "rootIssuerPublicKeyHex": "a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0",
  "runtimeCustodianPublicKeyHex": "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce",
  "credentialBrokerSignerPublicKeyHex": "d759793bbc13a2819a827c76adb6fba8a49aee007f49f2d0992d99b825ad2c48",
  "credentialBrokerRequestVerifierPublicKeyHex": "0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b0",
  "credentialBrokerRequestDomainSha256": "ce5bef764464d6c79aca51320bb575c9f91288dd46dcd64c0c128be582de2b35",
  "credentialBrokerRuntimeIdentitySha256": "fcbcaff38227f86150d35497f0c5ea24fa4e6932d0cfa757b6acc485cac58617",
  "credentialBrokerProtocolSha256": "92312c2bc3d8a57c5a4fb8ca00099e3836920dd2da03efa4b1dd9ecec5f50590",
  "credentialBrokerPeerPolicySha256": "f7f881314db9d3a9c6cda258ceb914da92f00906c4bf90dbdcf67ec297aaac84",
  "credentialStoreResourceMapSha256": "423fd97685af7c769fdc5ebee5bd56120ea36e8bc96579a2dac52f39a981789a",
  "credentialStoreRoutePolicySha256": "7567c1b00916b6ace1fbf1c5efb81ce6603a01d98e02d238a079325cda1145e1",
  "credentialStoreDnsPolicySha256": "30e20bca1f656f501b11cb74cdbc1a159f89fb05e1751a951bbe12e0f9f17827",
  "credentialStoreTlsServerPolicySha256": "f3b6137d28617f6423352e4a7a2df599d1caaefb5528c63fadbb1d4e5f01bfaf",
  "credentialStoreProtocolSha256": "6e31c19be2d85a8d2c9c30311e13500498365dce6b628b2235a214d16ef57901",
  "trustedClockProviderSha256": "bb4c27585d7712adb4a8d5c0973a3123a42a67995964b0510ffdb21d9e1cadb2",
  "entropyProviderSha256": "83761a698cb6f300add9c12415f4877650b53c6b75136c66f24759d7e01ba539",
  "sourcePolicySha256": "b938043cfaedfd235b7b2f46ee0f73c1ecb29c7d94632ccb8cff9d94824d0891",
  "runtimePolicySha256": "b8531e4533e88898cdc0cc1aa932e3259af2ff435ae523e6569269b8c606567f",
  "privilegedExecutablePolicySha256": "105bd1ce5e4669985b22082904d2cd5796f62841d30a9468b91960f00f752cf2",
  "privilegedExecutablePolicyGeneration": 0,
  "targetClass": "synthetic_only",
  "externalCapability": false,
  "liveAdapterAllowed": false
}
```

The all-zero revision is an explicit non-live sentinel. For source proof signing only, the public,
non-secret Ed25519 seeds are `[0x11; 32]` for bootstrap activation, `[0x22; 32]` for the root issuer,
`[0x33; 32]` for runtime custody, `[0x44; 32]` for the broker signer and `[0x5a; 32]` for registry/
broker-request verification. Their public keys are the five values above in the same order. These
seeds may exist only in coordinator `cfg(test)` fixtures or the already defined sealed synthetic
registry memfd; no other constructor or future live policy accepts a raw seed. This fixes the
exact valid bootstrap and installation-authorization signatures without creating a live trust root.
Every positive-generation or live-policy constructor must also reject the all-zero source revision
and reject any role public key that equals any of these five synthetic public keys, including reuse
under a different role. Negative tests cover every live role against every synthetic key and every
cross-role reuse; accepting an ordinary signature under a published fixture key is never a live
trust path.

The canonical JSON has this exact key order:

```text
schemaVersion, policyClass, sourceRevision,
proofBootstrapVerifierIdentitySha256, proofBootstrapManifestSha256,
proofBootstrapActivationPublicKeyHex,
rootIssuerPublicKeyHex, runtimeCustodianPublicKeyHex,
credentialBrokerSignerPublicKeyHex, credentialBrokerRequestVerifierPublicKeyHex,
credentialBrokerRequestDomainSha256, credentialBrokerRuntimeIdentitySha256,
credentialBrokerProtocolSha256,
credentialBrokerPeerPolicySha256, credentialStoreResourceMapSha256,
credentialStoreRoutePolicySha256, credentialStoreDnsPolicySha256,
credentialStoreTlsServerPolicySha256, credentialStoreProtocolSha256,
trustedClockProviderSha256, entropyProviderSha256,
sourcePolicySha256, runtimePolicySha256, privilegedExecutablePolicySha256,
privilegedExecutablePolicyGeneration, targetClass,
externalCapability, liveAdapterAllowed
```

`schemaVersion` is exactly `openspell.preparation-installed-root-policy.v1`. The source values fix
`policyClass` to `synthetic_deny_live`,
`privilegedExecutablePolicyGeneration` to zero, `targetClass` to `synthetic_only`, both booleans to
false, `sourceRevision` to lowercase 40-hex, 32-byte public keys to lowercase 64-hex and every
digest to lowercase 64-hex.
Unknown/reordered fields, a nonzero source generation or a digest mismatch refuses before registry
access.
The source slice compiles only a deny-live synthetic policy whose keys and target class cannot
authorize an external route.

For this source slice, `trustedClockProviderSha256` is exactly
`bb4c27585d7712adb4a8d5c0973a3123a42a67995964b0510ffdb21d9e1cadb2`, the SHA-256 of these exact
canonical bytes:

```json
{
  "schemaVersion": "openspell.linux-trusted-clock-provider.v1",
  "realtimeClock": "CLOCK_REALTIME",
  "monotonicClock": "CLOCK_BOOTTIME",
  "bootIdSysComponent": "sys",
  "bootIdSysResolveFlags": "RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS",
  "bootIdSysMountPolicy": "single_fixed_component_xdev_allowed",
  "bootIdSysMetadata": "procfs,root:root,directory,mode=0555,nlink=1,size=0,readonly,noappend,cloexec",
  "bootIdLeafRelativePath": "kernel/random/boot_id",
  "bootIdLeafResolveFlags": "RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV",
  "bootIdLeafMetadata": "procfs,root:root,regular,mode=0444,nlink=1,size=0,readonly,noappend,cloexec",
  "bootIdRevalidation": "reopen_exact_device_inode_statx_mount_id_and_path_identity",
  "timeNamespaceOffsetsPathTemplate": "<decimal-getpid>/timens_offsets",
  "timeNamespaceResolveFlags": "RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV",
  "timeNamespacePolicy": "current_process_zero_offsets",
  "procfsMagicHex": "00009fa0"
}
```

The policy deliberately does not contain the current bootstrap-record digest or its physical lock
identity. The signed bootstrap record contains `currentPolicySha256`, so including the reciprocal
record digest in policy bytes would create a cryptographic hash cycle. The verified lease derives
and carries the complete current-record and physical lock-identity digests; the later installation
authorization and state-root registry bind both.

For this source slice, `inspect_preparation_bootstrap` consumes one root-owned, already-open
synthetic-bootstrap root descriptor. It opens and takes the root's non-waiting shared OFD lock before
opening `CURRENT` or any referenced object, verifies the complete exact inventory and current
pointer fd-relative under that lock, and requires the current record's policy, verifier, manifest
and source tuple to equal the installed policy. The returned `PreparationBootstrapLeaseV1` owns the
inspected policy plus the root, lock, current, record and signature descriptors and retains the
shared lock. Installation or state-root inspection consumes that lease, takes the state-root
super-lock second and embeds the bootstrap lease into exactly one state-specific root capability;
authority
close drops state-root mutation/signing capability, then the super-lock, then the bootstrap lease.
The source-only format is generation zero and cannot authorize a live adapter.

The exact source-only synthetic-bootstrap inventory is:

```text
FORMAT
LOCK
CURRENT
objects/records/<sha256>
objects/signatures/<sha256>
```

`FORMAT` is exactly `openspell.synthetic-preparation-proof-bootstrap.v1\n`, with SHA-256
`2d725313c18b3834778b935550f47ad1cc85c00356a1e1004dcb35306f104f70`. `LOCK` is an empty,
mode-`0600`, link-count-one regular file. `CURRENT` is exactly the lowercase 64-hex complete-record
digest plus one line feed. The root and directories are mode `0700`; all files are mode `0600`,
regular and link-count one on the root device. Production ownership is uid/gid zero; alternate test
ownership is confined to `cfg(test)`. The inventory admits exactly one record, one raw 64-byte
signature and no other entry, with 16,384 bytes maximum for the record and 65,536 bytes total.

The one complete bootstrap record has this exact canonical key order:

```text
schemaVersion, registryGeneration, previousRegistryRecordSha256,
currentPolicySha256, currentManifestSha256, bootstrapVerifierIdentitySha256,
bootstrapLockIdentitySha256, sourceRevision, activatedAt,
issuerPublicKeySha256, detachedSignatureSha256
```

Its schema is `openspell.synthetic-preparation-proof-bootstrap-record.v1`; generation is zero; and
the predecessor is
`8a8a886ffc13da0bbb70e73d66268c16ad36ba5a23b00bb7e5bb911e01a10345`, the SHA-256 of
`openspell.synthetic-preparation-proof-bootstrap-genesis.v1\n`. Its signature domain is
`openspell.synthetic-preparation-proof-bootstrap-signature.v1\n<canonical-unsigned-record>\n`;
the unsigned record omits only `detachedSignatureSha256`. `issuerPublicKeySha256` is SHA-256 of the
raw `proofBootstrapActivationPublicKeyHex` public key. `activatedAt` uses canonical millisecond UTC.
`currentPolicySha256` is the complete installed-policy digest; the manifest, verifier and source
values equal the corresponding policy fields.

`bootstrapLockIdentitySha256` is SHA-256 of
`openspell.synthetic-preparation-proof-bootstrap-lock-identity.v1\n<canonical-identity>\n`.
The identity key order is `schemaVersion`, `filesystemDeviceDecimal`, `inodeDecimal`, `ownerUid`,
`ownerGid`, `modeOctal`, `linkCount`, `sizeBytes`; its schema is the domain name without the terminal
line feed, and its scalar rules match the state-root super-lock identity. The verifier derives this
identity from the held locked fd and requires it to equal the signed current record and the `LOCK`
pathname entry before returning and again before every state-root mutation and success. Unknown,
missing, extra, linked, reordered, noncanonical, misowned, replaced or stale-current content
refuses. Because `CURRENT` and its only object set are immutable in this source format, there is no
source activation or mutable head.

State-root installation is separately authorized. `installation_authorization_bytes` are this
canonical record in exact key order:

```text
schemaVersion, installationAuthorizationNonce, sourceRevision,
proofBootstrapRegistrySha256, proofBootstrapVerifierIdentitySha256,
proofBootstrapManifestSha256, proofBootstrapLockIdentitySha256,
boundStateRootIdentitySha256, preparationPolicySha256,
privilegedExecutablePolicySha256, privilegedExecutablePolicyGeneration,
registrySignerPublicKeySha256, trustedClockProviderSha256, activeFormat,
activeJournalName, targetClass, externalCapability, liveAdapterAllowed,
maximumDurationSeconds, issuedAt, expiresAt, authenticatedOperatorIdentitySha256,
osAuthenticationSessionSha256, authenticatedAt, issuerPublicKeySha256,
detachedSignatureSha256
```

`schemaVersion` is `openspell.preparation-state-root-installation-authorization.v1`; the signing
domain is
`openspell.preparation-state-root-installation-authorization-signature.v1\n<canonical-unsigned-record>\n`.
The unsigned encoding omits only `detachedSignatureSha256`. The issuer is the installed policy's
`rootIssuerPublicKeyHex`; `issuerPublicKeySha256` is SHA-256 of that raw public key. The registry
signing key descriptor's public component and `registrySignerPublicKeySha256` must match the
installed policy's `credentialBrokerRequestVerifierPublicKeyHex`.
`proofBootstrapRegistrySha256` is the SHA-256 of the lease's complete synthetic current record and
`proofBootstrapLockIdentitySha256` is its verified physical lock-identity digest; neither value
comes from the installed policy or caller fields. The policy, bootstrap,
executable-policy, source, clock, target class and live-capability fields must exactly match the
installed policy and current proof-bootstrap tuple. `activeFormat` and `activeJournalName` equal the
compiled constants `preparation_v2` and `PREPARATION_JOURNAL_V2`; they are not caller- or
policy-selected fields. Source fixtures require generation
zero, `synthetic_only` and both booleans false; a later final policy requires its positive activated
generation and exact reviewed values. `maximumDurationSeconds` is 300. The three timestamps use the
operation authorization's canonical millisecond UTC form and ordering/freshness rules, with
`0 < expiresAt - issuedAt <= 300 seconds`. The nonce is lowercase 64-hex and the authorization is
bound to one state-root identity, so it cannot initialize a second root.

The source-only `registry_signing_key` descriptor is a synthetic sealed Linux memfd containing
exactly one fixed, public, non-secret 32-byte Ed25519 test seed and no framing. Every seed byte is
`0x5a`; its Ed25519 public key is
`0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b0`. It proves parsing,
key matching, signing and storage mechanics only; it does not prove exclusive signer custody and
any holder or duplicate may read the public fixture bytes. Before reading it, the installer must already have
verified `policyClass: synthetic_deny_live`, `targetClass: synthetic_only` and both capability
booleans false. The descriptor must have `FD_CLOEXEC`, `O_RDWR`, tmpfs magic, size 32, link count
zero, mode `0600`, production uid/gid zero and at least `F_SEAL_WRITE | F_SEAL_GROW |
F_SEAL_SHRINK | F_SEAL_SEAL`; additional kernel hardening seals are allowed. It is read exactly once
with offset-independent `pread`, the Ed25519 public component must equal
`credentialBrokerRequestVerifierPublicKeyHex`, and its raw-seed digest must never appear in a record.
The installer performs one `pread`; only its local seed buffer and signing object are zeroized on
every outcome. The sealed memfd itself is immutable and intentionally not claimed to be erased,
single-reader or unreadable to the supplying test harness. EOF, short/long content, missing seals,
path-backed files, wrong flags/metadata/filesystem or key mismatch refuses before the first
state-root child. A crate-private `cfg(test)` expected-owner override permits only the current test
uid/gid for this descriptor and the synthetic filesystem fixtures; it cannot compile into a
dependency build, cannot be selected through the bridge and leaves production validation fixed at
uid/gid zero. `cfg(test)` may construct this exact memfd from the fixed public seed. Cross-crate
bridge success is instead accepted only in the isolated root proof container defined below: that
container runs without a user override, has no writable host mount, opens its actual container
procfs and creates every signer and state-root fixture inside its private tmpfs. A local non-root invocation may run pure
and refusal tests, but it cannot claim the bridge-success acceptance row. No live
policy or external constructor may accept this raw-seed format; the adapter-candidate addendum must
define a distinct signer capability and entry point.

The source-only `trusted_clock_procfs_root` descriptor is an already-open `O_RDONLY | O_DIRECTORY |
O_CLOEXEC` fd for procfs as observed by the current root-authority process. The installer verifies
`FD_CLOEXEC`, directory type, procfs filesystem magic `0x00009fa0`, root ownership and absence of
writable/append flags, then obtains a positive `getpid()` and formats it as unsigned base-ten ASCII
with no sign or leading zeroes. `readlinkat(procfs_root, "self")` must return exactly that decimal
component; this checks the procfs view without following its magic link. A second `getpid()` must
match. The installer opens the internally constructed `<decimal-getpid>/timens_offsets` path with
`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)`.
Container runtimes commonly mount `/proc/sys` as a distinct read-only procfs mount. For the boot-ID
read only, the installer therefore opens the single fixed component `sys` relative to the trusted
procfs root with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`, deliberately
omitting `RESOLVE_NO_XDEV` for that one component. It requires the resulting descriptor to be an
`O_RDONLY | O_DIRECTORY | O_CLOEXEC` root-owned procfs directory with no writable or append status,
mode `0555`, link count one and size zero. It records the descriptor's device, inode and statx mount
ID and proves that reopening the procfs-root pathname `sys` resolves to that same identity. From
that held, validated descriptor it opens only `kernel/random/boot_id` with
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV`. The boot-ID
descriptor must be an `O_RDONLY | O_CLOEXEC` root-owned procfs regular file with no writable or
append status, mode `0444`, link count one and size zero. Each sample reopens both descriptors,
checks their complete metadata, filesystem magic, device/inode/mount identities and pathname-to-fd
identity, and refuses if either identity changed. The isolated root-container positive proof must
also establish that its trusted procfs root and `sys` descriptors have distinct statx mount IDs;
thus the accepted crossing is exactly the fixed `sys` component. A mount below that descriptor is
rejected by restored `RESOLVE_NO_XDEV`. This exception does not apply to the PID path or any
caller-selected path. The installer never resolves `self`. It parses the time-
namespace offsets semantically and requires exactly `monotonic 0 0` and `boottime 0 0`, refusing
missing, extra, nonzero or malformed rows. Each sample reads exactly one lowercase canonical UUID
plus line feed, reads `CLOCK_REALTIME` and `CLOCK_BOOTTIME` directly with `clock_gettime`, then
reopens and rereads boot ID plus offsets and requires both unchanged. This is explicitly the current
process's zero-offset time namespace, not a claim about an initial host user/PID namespace.
Realtime is retained at nanosecond precision for
authorization comparisons and floored to milliseconds only when a canonical timestamp is stored;
boottime is a nonnegative nanosecond count. Initial and pre-final-transition samples must have the
same boot ID, nondecreasing clocks and exact provider-identity digest above. There is no IPC frame,
network, caller timestamp, timeout or fallback clock. The descriptor is consumed on every outcome.
Crate-private `cfg(test)` clock traits may provide deterministic unit samples but cannot construct a
bridge capability or compile into non-test code.

`boundStateRootIdentitySha256` is SHA-256 of
`openspell.hosted-migration-state-root-identity.v1\n<canonical-identity>\n`. Its canonical key order
is `schemaVersion`, `filesystemDeviceDecimal`, `inodeDecimal`, `ownerUid`, `ownerGid`, `modeOctal`;
the schema is `openspell.hosted-migration-state-root-identity.v1` and the scalar encodings follow
the journal identity rules. Installation verifies this identity before the first write and again
immediately before the final transition publication. The signing-key and clock descriptors are
consumed on every outcome. Successful installation returns `FreshPreparationStateRootV1`. After
process loss, the three state-root inspectors verify the same policy, signed registry,
root/super-lock/journal identities and exact inventory before returning mutually exclusive sealed
types: fresh accepts only registry generation one plus an exactly empty v2 journal; active accepts
only the exact named single nonterminal operation/cross-store state; closed accepts only the exact
named single `closed` operation. No type converts to another in caller code. The inspectors neither
install, repair nor change content; they may perform only the explicit durability-completion
sync/reverification below.

The later adapter-candidate addendum must define a separate external bootstrap constructor, mutable
append-only registry/current-head format and canonical signed-policy framing. It must not reinterpret
or widen the immutable synthetic format above. Its small bootstrap verifier/root launcher is pinned
by a WP-201-owned, nondeployable proof-bootstrap record under a separate attended trust root; WP-203
later adopts and revalidates that exact mechanism rather than being a prerequisite for WP-201 or
WP-202.
The verifier embeds only the policy/activation verification public key and signature domains, never
a future policy or manifest digest. It verifies the active policy tuple, then verifies the separately
hashed subordinate executable manifest and constructs the sealed installed-policy capability. The
final signed policy and authorization bind that manifest's exact digest and generation. The
subordinate manifest may pin the already measured root custodian, adapter, helpers, broker client,
gateway, observer and runtime roots, but must exclude the bootstrap verifier/root launcher and
proof-bootstrap trust root that authenticate it. This produces a one-way chain rather than a
policy/binary hash cycle. No active signed final policy means the staged candidate can construct
only the synthetic deny-live capability.

The adapter-candidate addendum must define a root-owned `ProofBootstrapRegistryV1` outside the
operation state root with this canonical tuple:

```text
schemaVersion, registryId, currentGeneration, currentPolicySha256,
currentManifestSha256, bootstrapVerifierIdentitySha256, previousRegistrySha256,
boundStateRootIdentitySha256, activationAuthorizationSha256, activatedAt,
detachedSignatureSha256
```

The nondeployable proof bootstrap owns a separate OFD lock and append-only signed registry chain.
The lock order is always bootstrap registry, then the one bound operation state-root super-lock.
Operation open takes a shared bootstrap lease before its state-root lock and holds that lease through
terminal closure; the lease is an authority-internal mutation guard outside the 23-component
external vector and must be dropped before `authorityMutationGuardCount: 0`. Normal open and active recovery require equality with the current
`{generation, policyDigest, manifestDigest}` and never advance it.

Policy activation takes the exclusive bootstrap lock, opens the bound state root in the same lock
order and refuses while its registry has any nonterminal/recovery-only operation. Only then may a
fresh attended activation authorization atomically compare-and-set the complete current tuple to a
strictly higher generation. Activation writes and syncs a new content-addressed record, atomically
publishes and syncs the head, then reopens and verifies it; every crash cut yields exactly the old
tuple, exactly the new tuple or recovery-only, never an inferred head. A crashed nonterminal
operation therefore prevents head advance until exact cleanup/terminality.

After an operation is durably `closed`, only `ClosedPreparationStateRootV1` may enter
`reopen_closed_authority`; that type is statically ineligible for mutation open, cleanup or normal
advancement. In this source slice, `inspect_closed_preparation_state_root` constructs it only from
the still-current immutable synthetic-bootstrap lease after proving the named v2 operation exactly
closed; the fresh and active inspectors refuse an exactly closed journal. Before an
external mutable bootstrap exists, the adapter-candidate addendum must define a second constructor
that holds the current bootstrap lock, verifies the complete activation chain from current head to
the operation's journal-bound historical tuple and returns only
`ClosedPreparationStateRootV1`. It must not return a mutation-capable installed-root type. Stale
policy bytes can therefore neither start nor recover active work after activation, while an already
closed lost response remains reproducible through the separately verified historical path. The
proof bootstrap record, lock, activation command and private path are nondeployable WP-201
external-proof artifacts; they create no service/listener and grant only one separately authorized
disposable execution. WP-203 later independently pins the deployable installer/state root and
imports no implicit authority from this proof registry.

`open_preparation_authority` is the only constructor for normal advancement;
`reopen_active_preparation_authority` is the separate cleanup/reconciliation-only custody
constructor described below. Normal open consumes a `FreshPreparationStateRootV1` that already
owns the verified policy/bootstrap capabilities,
the shared bootstrap lock and the exclusive state-root super-lock. It revalidates every retained
descriptor fd-relative, then verifies the operation authorization signature with
`rootIssuerPublicKeyHex` and the supplied signing key's public component against
`credentialBrokerRequestVerifierPublicKeyHex` before trusting any operation field. It neither
reopens a path nor takes a second lock. That signing key is confined to the root authority and
signs the journal plus one-shot broker requests; the broker receives no private key.
The broker-control input must be an already connected `AF_UNIX SOCK_SEQPACKET` descriptor opened by
the proof bootstrap, with no queued records or descriptors. Before registry mutation, the root
checks socket type/state, one fixed mutual-authentication handshake and the policy-pinned peer
uid/gid/pidfd/start/cgroup/runtime identity, then retains the connection as an authority-internal
control capability. It performs no path/address lookup and receives no factory, listener, filesystem
or arbitrary-connect capability. A restarted active-operation authority must receive a freshly
authenticated connection to the same broker identity; terminal close drops it before the
post-authority observation counts are derived.
`reopen_active_preparation_authority` is the only restart path for a nonterminal operation. It
requires the exact authorization bytes/signature and signer already bound by the verified intent,
accepts the otherwise-used operation id and nonce only when every byte equals that journal binding,
and never appends a second intent or samples entropy. If the intent is complete and generation two
has no final-name artifact, it may finish only the same journal-bound target CAS before returning;
a partial registry suffix remains permanently recovery-only. The returned
`RecoveryPreparationAuthorityV2` has no normal `begin_effect`, ticket, execution or terminal-success
method. It may authenticate bounded evidence, reconcile an already journaled effect and append only
the zero-acquisition cleanup lane for exact journal-bound recovery anchors. Authorization expiry
forces cleanup-only behavior rather than granting advancement or abandoning held resources. No
ephemeral key, nonce or capability is reconstructed unless its complete identity and cleanup
custody were already journaled; missing custody remains recovery-only.
`open_preparation_authority` then verifies the clock and entropy provider identities against both
the signed authorization
fields and the final executable policy before sampling either provider. The clock protocol supplies
one authenticated realtime/`CLOCK_BOOTTIME`-nanoseconds/boot-id tuple; the entropy protocol supplies exactly one
authenticated 256-bit value and EOF. Reuse, extra bytes, provider substitution, caller bytes or a
provider whose measured executable/runtime is not pinned refuses before registry generation two or
any v2 operation-record publication. It
consumes all input descriptors. Source tests use
fixed fixture providers with the same framing and identity checks; no caller chooses a clock value,
nonce or entropy value. Test callers can therefore
open temporary synthetic roots with ordinary `OwnedFd`s; a later external adapter must supply the
same descriptor set from its separately reviewed proof bootstrap. No raw signer, descriptor or generic
append is returned.

The single 256-bit entropy record is input keying material to RFC 5869 HKDF-SHA-256, never a nonce
itself. The extract salt is
`SHA256("openspell.preparation-entropy-extract.v1\n" || authorizationSha256Bytes || ownerBootIdSha256Bytes)`.
Every output uses
`"openspell.preparation-entropy-expand.v1\n" || operationId || "\n" ||
twoDigitEffectCode || "\n" || twoDigitSlot || "\n" || purpose || "\n"` as `info`.
A compile-time table uniquely assigns effect code, slot, purpose and output length to every journal
incarnation, ticket nonce, credential/gateway lease nonce, filesystem/cell nonce, local surrogate
and TLS key seed; there is no free-form label or caller counter. Nonces, surrogates and Ed25519 key
seeds are exactly 32 bytes, and no tuple repeats. All required outputs are expanded once at open,
checked for same-class collision against each other and retained registry identities, then the
input seed and HKDF pseudorandom key are zeroized before any resource or network effect. A
collision, expansion error, missing table row or attempted later entropy read refuses; no new seed
is drawn and no output crosses into public evidence.

`close_no_apply` commits and reopens the terminal journal while it still owns mutation authority,
then consumes itself and closes the journal signer, mutation descriptors and OFD-lock guard before
returning its non-authorizing receipt bytes. It cannot derive success. A separately pre-opened or
installer-reopened state-root descriptor and independently opened retained-bundle descriptor must
then enter `inspect_closed_preparation_state_root` and `reopen_closed_authority` with the exact
source-current or externally chain-verified historical policy capability described above. The
resulting closed-root capability must equal the operation's journal-bound historical activation-
chain tuple and is rejected unless the journal is already exactly `closed`; reopening never advances
or mutates the current head. It accepts no signing key and recognizes only the exact terminal
operation digest. The read-only
verifier checks the registry issuer against the installed policy before trusting the chain, takes a
non-waiting exclusive OFD lock and holds
it through complete registry/journal/bundle verification and in-memory observation construction,
so no mutation authority can appear between its absence proof and derivation. It verifies the
retained bundle descriptor against the journal-bound WP-197 identity, then consumes/closes every
reader descriptor and the lock guard immediately before returning the already-built bytes. The
bundle never enters the exact state-root inventory. This same entry point handles a lost outer
response after process restart.

`effect_code` is one through 43 in the table's order. Each code selects one compiled request schema,
producer class, descriptor count/type, delta row and deadline budget. `request_bytes` cannot change
those values. The root derives the request digest and recovery-anchor digest only after verifying
every supplied descriptor identity or authorization-bound resource digest. Missing/extra/wrong
descriptors refuse before the intent append. This gives `begin_effect` all data required by the
normative intent without creating a caller-selected effect policy. It refuses after the operation
enters cleanup-only or while a normal effect is unclassified.

`begin_recovery_cleanup` is a distinct recovery-only lane. The root, not the caller, derives its
canonical request from the verified journal. It accepts only release effect codes 3, 9, 21, 22, 30,
31 and 33 through 43, only when the corresponding accepted identity remains live, and only with that
identity's exact immutable descriptors. Every cleanup intent has `maximumPositiveDelta` zero and
may only remove its named resource components. It cannot issue a ticket, open a credential or
network, invoke the observer, resume a normal effect, close an unknown identity or reach a success
terminal. Cleanup effects serialize per resource identity. An unclassifiable cleanup attempt keeps
that resource live and recovery-only but does not prevent cleanup of a disjoint previously accepted
identity. Thus an uncertain normal effect freezes advancement without preventing best-effort,
journaled release of resources whose custody is already exact.
Entry durably commits a `cleanup_only` milestone when journal storage remains writable and burns all
normal/ticket permits before a cleanup adapter call. If the journal itself cannot sync, the root
custodian still closes descriptor-held resources directly, emits no terminal claim and remains
recovery-only; an unjournaled close can never be upgraded into success.

`authenticate_evidence_channel` consumes one pre-opened Unix record descriptor, requires the fixed
magic/version/length/hash, exactly one credentials control record, the policy-pinned peer
uid/gid/cgroup/runtime identity and EOF after one bounded record, and returns no descriptor. The
root signs the resulting accepted/no-accept/closed journal record itself. Thus gateway, observer and
runtime helpers never receive a journal signing key and cannot self-authorize evidence.

`mark_executing` consumes the prepared handle but `ExecutingGrantV2` retains the exact signed ticket
and signed executing transition for independent runtime verification. Its terminal token remains
opaque. The root accepts a terminal/no-spawn record only when its runtime-custodian signature and
all ticket/executing/policy/resource identities match that token. Each effect acceptance/closure is
verified against the producer class and authenticated channel fixed for its effect code; a
caller-selected key or self-described producer identity never verifies.

The source-slice runtime-proof bridge is exactly:

```rust
#[cfg(feature = "wp201-internal")]
#[doc(hidden)]
pub mod wp201_internal {
    pub struct InstalledPreparationRuntimePolicyV1 { /* sealed, non-Clone */ }
    pub struct VerifiedPreparationRuntimeV2 { /* holds external trust pins; non-Clone */ }
    pub struct VerifiedWp197Bundle { /* sealed, non-Clone */ }
    pub struct VerifiedPhasePlanV2 { /* sealed, non-Clone */ }
    pub struct VerifiedTerminalGraphV2 { /* sealed, non-Clone */ }

    pub fn inspect_installed_runtime_policy(policy: std::os::fd::OwnedFd)
        -> Result<InstalledPreparationRuntimePolicyV1, RuntimeRefusal>;
    pub fn inspect_preparation_runtime(policy: InstalledPreparationRuntimePolicyV1,
        source_root: std::os::fd::OwnedFd,
        runtime_root: std::os::fd::OwnedFd,
        authorization_bytes: &[u8], authorization_signature: &[u8; 64])
        -> Result<VerifiedPreparationRuntimeV2, RuntimeRefusal>;
    pub fn verify_wp197_bundle(runtime: &VerifiedPreparationRuntimeV2,
        bundle: std::os::fd::OwnedFd, history: std::os::fd::OwnedFd,
        output: std::os::fd::OwnedFd)
        -> Result<VerifiedWp197Bundle, RuntimeRefusal>;
    pub fn verify_phase_plan(runtime: &VerifiedPreparationRuntimeV2,
        ticket_bytes: &[u8], ticket_signature: &[u8; 64],
        executing_bytes: &[u8], executing_signature: &[u8; 64])
        -> Result<VerifiedPhasePlanV2, RuntimeRefusal>;
    pub fn verify_terminal_graph(runtime: &VerifiedPreparationRuntimeV2,
        plan: VerifiedPhasePlanV2, terminal_bytes: &[u8],
        terminal_signature: &[u8; 64])
        -> Result<VerifiedTerminalGraphV2, RuntimeRefusal>;
}
```

For this source slice, `inspect_installed_runtime_policy` independently compares the complete
synthetic policy descriptor to the runtime crate's compile-time SHA-256 before parsing the same root
issuer, runtime-custodian, source/runtime and executable-policy pins used by the root bridge. It
accepts no caller digest or key. Cross-crate golden tests require the two independently compiled
source-policy bytes and digest to agree exactly. The source slice again contains only the deny-live
synthetic policy. The later external runtime constructor must consume only the installed capability
produced by the independently pinned bootstrap verifier and must not embed the final policy or
subordinate-manifest digest.

The open runtime function is its only custody constructor. It consumes the installed policy,
verifies the source/image descriptors against it, and verifies the authorization signature against
its externally pinned root issuer before trusting authorization fields. It independently verifies
root signatures/chain and terminal evidence against the installed runtime-custodian key and exact
ticket binding. It does not launch, sign, open a network or hold a hosted credential in this source
slice.

The coordinator's 43 effects run only through a package-private `#[cfg(test)]`
`SyntheticPreparationEffects` implementation whose complete input/output tape is fixed by the
golden. It cannot accept a command, URL, SQL, credential or callback, and no non-test constructor
exists. WP-200 kernel custody is reused only from an explicit synthetic test target. A later
adapter-candidate architecture addendum must specify the stepped adapter signatures, signer custody,
deny-live construction and exact ignored path before their inert implementation is added; the final
policy must pin that already measured implementation before any external capability is released.
Therefore the present source bridge proves
composition and state transitions without pretending to be a production kernel adapter.

Capability types are non-`Clone`, non-`Copy` and non-serializable; canonical bytes are safe to copy
but carry no authority without pinned keys and owned capabilities. Neither bridge
returns a signer, journal/storage handle, raw descriptor, generic phase, argv, environment,
executable or callback. Phase policy derives all invocation/process fields and accepts no command,
target, URL, SQL, retry or apply selector. Compile-fail tests prove those restrictions and that v1
approval/consume types are unreachable through `wp201-internal`.

WP-197 composition is not reimplemented in Rust and no Node process enters the privileged
operation. Before external execution, WP-197's existing TypeScript builder creates and verifies one
root-owned sealed bundle under separate attended acquisition authority. The operation receives only
an owned bundle-root descriptor. The runtime bridge independently validates the exact 46 migration
files, 646,628 migration bytes, manifest bytes, source revision, terminal version and three fixed
digests, compares all 41 baseline files byte-for-byte with the fresh history root, and constructs
the CLI workdir through owned descriptors. `src/composition.test.ts` invokes the authoritative
TypeScript verifier on a synthetic bundle and requires exact field/digest agreement with the Rust
descriptor verification. The TypeScript evidence is an independent oracle, not a trusted runtime
assertion.

The source coordinator exposes no production constructor. Its only complete entry point is this
test-only proof function:

```rust
#[cfg(test)]
fn prove_synthetic_once(
    descriptors: SyntheticDescriptorSet,
    tape: SyntheticPreparationTape,
    deadline: AbsoluteMonotonicDeadline,
) -> PreparationOutcome;
```

Both input types are package-private, constructible only by the synthetic test module and contain no
URL, hosted credential or network handle. The adapter-candidate addendum must define a deny-live
candidate boundary before its ignored implementation can exist; the final executable-policy
addendum must pin those candidate bytes before an external capability constructor can exist. The
outcome is one of:

```text
observed(closed_observation_digest)
refused(fixed_code)
recovery_only(operation_digest)
```

No outcome contains a credential, raw target, endpoint, path, process identity, live descriptor,
ticket, approval, reusable lease or `ready`/`safe` classification.

## Authority topology

```text
root preparation authority + fresh v2 journal
              |
              v
      private coordinator
       /       |        \
      v        v         v
fixed public   credential/egress    independent observer
acquisition    gateway              fixed read-only corpus
helper              |
                    v
          credentialless measured CLI cell
          history_fetch or dry_run only
```

The responsibilities are deliberately split:

| Component | May hold | Must not hold or do |
|---|---|---|
| Nondeployable proof bootstrap | activation key verification roots, registry lock, signed current/historical tuples, measured subordinate descriptors | hosted credential, target route, operation mutation after capability release, self-listed manifest identity |
| Root authority | disposable permit, signing key, journal descriptors, exact authenticated local broker control | hosted credential, external network, generic launch |
| Acquisition helper | fixed public-release routes, root-owned destination descriptors | target route, hosted credential, caller URL |
| Credential/egress gateway | exact target credentials, fixed upstream routes, authenticated evidence channel | root journal key, generic URL/SQL/command, agent IPC |
| Guarded credential broker | one authorization-bound mapped secret at a time, exact pinned store route/DNS/TLS/protocol, signed one-shot transfer receipt | target route, Amazon/provider API, root private key, retained operation secret, caller-selected resource/locator |
| CLI cell | measured official runtime and operation-local gateway surrogates | raw hosted credential, direct Internet, host mounts, phase choice |
| Observer | separate observer credential, fixed query corpus, authenticated evidence channel | root journal key, CLI credential, arbitrary SQL, mutation, apply authority |
| Coordinator | opaque capabilities and exact phase machine | raw user inputs, general execution, deployment, service control |

No process may simultaneously possess public acquisition reachability and a hosted credential.

## Disposable target and credentials

The target preimage is one exact lowercase 20-character project reference. It may exist only in
root/gateway custody and in the measured private CLI argv as the exact value following
`--project-ref`, as required by the WP-197 invocation contract. The CLI receives no alternate,
linked, default or rewritten target value. Public and agent-visible evidence contains only the
WP-197 target-selection fingerprint and operation-private digests.

"Disposable" requires evidence stronger than a name. Before any credential is acquired, the root
authority verifies this canonical, Ed25519-signed authorization in exact key order:

```json
{
  "schemaVersion": "openspell.disposable-preparation-authorization.v1",
  "operationId": "...",
  "authorizationNonce": "...",
  "sourceRevision": "...",
  "proofBootstrapRegistrySha256": "...",
  "proofBootstrapVerifierIdentitySha256": "...",
  "targetFingerprint": "...",
  "providerProjectIdentitySha256": "...",
  "providerOrganizationIdentitySha256": "...",
  "productionExclusionInventorySha256": "...",
  "controlCredentialResourceSha256": "...",
  "preparationDatabaseCredentialResourceSha256": "...",
  "observerDatabaseCredentialResourceSha256": "...",
  "credentialScopePolicySha256": "...",
  "runtimeCustodianPublicKeySha256": "...",
  "credentialBrokerSignerPublicKeySha256": "...",
  "credentialBrokerRequestVerifierPublicKeySha256": "...",
  "credentialBrokerRequestDomainSha256": "...",
  "credentialBrokerRuntimeIdentitySha256": "...",
  "credentialBrokerProtocolSha256": "...",
  "credentialBrokerPeerPolicySha256": "...",
  "credentialStoreResourceMapSha256": "...",
  "credentialStoreRoutePolicySha256": "...",
  "credentialStoreDnsPolicySha256": "...",
  "credentialStoreTlsServerPolicySha256": "...",
  "credentialStoreProtocolSha256": "...",
  "trustedClockProviderSha256": "...",
  "entropyProviderSha256": "...",
  "gatewayRuntimeIdentitySha256": "...",
  "observerRuntimeIdentitySha256": "...",
  "evidenceChannelPolicySha256": "...",
  "permittedPhases": ["history_fetch", "dry_run"],
  "expectedBaselineFiles": 41,
  "expectedBaselineBytes": 279677,
  "expectedSuffixFiles": 5,
  "expectedSuffixBytes": 366951,
  "officialAcquisitionPolicySha256": "...",
  "runtimePolicySha256": "...",
  "privilegedExecutablePolicySha256": "...",
  "privilegedExecutablePolicyGeneration": 0,
  "gatewayPolicySha256": "...",
  "egressPolicySha256": "...",
  "observerPolicySha256": "...",
  "writeCapability": false,
  "mayCreateTarget": false,
  "mayDeleteTarget": false,
  "mayProvisionCredential": false,
  "mayRotateCredential": false,
  "mayRevokeCredential": false,
  "maximumDurationSeconds": 3600,
  "issuedAt": "...",
  "expiresAt": "...",
  "authenticatedOperatorIdentitySha256": "...",
  "osAuthenticationSessionSha256": "...",
  "authenticatedAt": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

The signature domain is
`openspell.disposable-preparation-authorization-signature.v1\n<canonical-unsigned-record>\n`.
The authorization issuer generates the operation id and nonce; neither is an unsigned caller field.
Fresh `open_preparation_authority` refuses either value unless it is fresh and unused in the
verified v2 journal history; the active-recovery exception is the exact journal-bound match above.
While holding the super-lock, open first verifies freshness, durably appends the v2 operation intent,
then compare-and-sets registry generation one to generation two with target generation exactly one.
No external effect or target quarantine begins until both publications reopen and verify. A cut
before a complete intent leaves no registry target mutation; an uncertain intent is recovery-only.
A cut after intent but before the first generation-two final name exists may resume only that exact
generation-two compare-and-set under the same authorization; it cannot admit a new operation,
nonce, target or entropy draw. Any partial generation-two final-name suffix is permanently
recovery-only and is never overwritten or adopted. A complete, cryptographically valid generation-
two transition is durability-completed and verified from readback as specified for the registry
below, then continues without retrying publication.
Authorization binds three already-existing credential resources and never permits their lifecycle
mutation.
`sourceRevision` is the lowercase 40-hex reviewed implementation revision pinned by the final
executable-policy addendum, not this architecture's base revision or a runtime-selected branch head.
`privilegedExecutablePolicySha256` is the subordinate executable-manifest digest, never the digest
of the bootstrap verifier that verifies it. Source fixtures require generation zero. External
policy activation requires a positive generation strictly above the prior registry tuple; ordinary
mutation open and active recovery then require exact equality with the activated tuple; closed
read-only recovery uses its journal-bound historical chain tuple. The signed operation
authorization must match the bootstrap-registry digest, verifier identity, policy digest and
generation exactly.
`issuedAt`, `authenticatedAt` and `expiresAt` use canonical UTC millisecond form
`YYYY-MM-DDTHH:MM:SS.sssZ`. The root requires
`authenticatedAt <= issuedAt <= trustedRealtime <= expiresAt`, authentication age at most 60
seconds, issue age at most 30 seconds, no future skew, and
`0 < expiresAt - issuedAt <= 3,420 seconds`; `maximumDurationSeconds` is exactly 3,600. The signed
external-window expiry is at least 180 seconds after authorization expiry while the complete
window remains within 3,600 seconds of `issuedAt`. Any overflow, ordering error, stale
authentication or missing reserve refuses before a lease or network release.
Throughout this design, "monotonic" means Linux `CLOCK_BOOTTIME` exclusively: it includes suspend
time and is paired only with `timerfd_create(CLOCK_BOOTTIME, TFD_CLOEXEC)`, absolute
`TFD_TIMER_ABSTIME`, task/gateway `clock_gettime(CLOCK_BOOTTIME)` and
`bpf_ktime_get_boot_ns`. `CLOCK_MONOTONIC`, `bpf_ktime_get_ns` and clock-domain fallback refuse.
At authority open, one trusted realtime/`CLOCK_BOOTTIME` sample converts `expiresAt` into an immutable
boot-time authorization deadline. Normal work uses the minimum of that deadline and the operation's
3,420-second normal-work cutoff. Every ticket, effect, credential lease, gateway lease and child
deadline is capped to the same value. Realtime rollback/step, boot-id change or reaching that value
enters cleanup-only immediately; history or dry run never continues under an expired permit. The
separate external window and overall 3,600-second deadline may cover only the reserved 180-second
cleanup after authorization expiry.
The permit is necessary but is not target attestation. After leases and gateways are durably bound,
three independent evidence families must agree: the root permit; provider/API observations from
the control gateway; and database/TLS observations from the independent observer. Gateway and
observer records arrive over fixed one-record authenticated descriptor channels; the root verifies
peer uid/gid, pidfd/start, runtime identity, framing and EOF, then hashes and signs their journal
leaves. Neither producer holds the root key. The records bind
the exact project and organization identities, credential-resource/scope digests, endpoint
certificate/peer digests, database identity and target fingerprint. Target attestation commits only
after that agreement and an exact 41-version hosted prefix are proved.

Use three separate upstream credentials:

1. target-scoped control-plane read credential;
2. preparation-only database credential; and
3. independent observer-only database credential.

Both database identities must be non-superuser, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
`NOBYPASSRLS`, without memberships, role switching, object ownership, database creation, DDL, or
`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` and `TRIGGER`. The preparation identity may
have only `CONNECT`, required schema `USAGE` and exact migration-history `SELECT`. The observer may
have only `CONNECT`, required schema `USAGE` and `SELECT` on the compiled observation corpus.
Direct, inherited and `PUBLIC` routine `EXECUTE` authority must be zero for both identities; any
required function, procedure, `SECURITY DEFINER` path or routine dependency makes this preparation
design a no-go and requires a new reviewed architecture rather than a policy exception. Every
grant, default privilege, routine privilege and role membership is inventoried. Session
`default_transaction_read_only` is defense in depth, never the authority boundary.

Classic, personal, organization-wide, broad service, cross-project or `service_role` credentials
are no-go. If the exact CLI cannot complete preparation with the minimum scope, WP-201 refuses.

## The CLI never receives a hosted credential

WP-197's provisional invocation record listed `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_DB_PASSWORD`. WP-201 replaces it with a versioned preparation-only invocation record.
Those environment keys contain one-use local gateway surrogates, never upstream secret material.
The record binds:

```text
credential_transport = gateway_surrogate_v1
gateway_policy_sha256
gateway_lease_sha256
upstream_scope_evidence_sha256
hosted_credential_exposure_count = 0
```

Raw upstream values enter the gateway only through pre-opened private secret descriptors. They do
not appear in CLI argv, environment values, files, logs, output, core, `/proc`, inherited file
descriptors or evidence. The local surrogate is useless outside its exact live lease and is revoked
at phase terminality.

The CLI cell has no external route. It can reach only its operation-specific local gateway. The
gateway, not the CLI, resolves DNS and owns upstream sockets.

## Gateway and egress rules

The root first creates the gateway containment as an empty cgroup plus new mount, user and
route-empty network namespaces. `clone3`/`CLONE_INTO_CGROUP` and descriptor-held start traps prove
no child instruction executes outside that containment. While the cell has zero target tasks and no
credential, effect 7 stages one measured credentialless setup helper under the already accepted
cgroup and records its pidfd, start identity, four duplicated namespace/egress-control handles and
parent-death custody. Effect 8 lets only that helper receive `CAP_NET_ADMIN`, setns and
netlink/nftables/BPF authority; it installs the fixed default-deny allowlist, re-reads and attests
the resulting route/firewall/BPF state, and irreversibly drops all authority. The cgroup ingress and
egress BPF packet gates bind the authorization boot id and absolute `releaseNotAfterBootTimeNs`,
use `bpf_ktime_get_boot_ns` for every packet, and pass only the exact allowed tuples
while kernel time is strictly before the deadline. Their deadline value/map is frozen before the
helper drops authority and cannot be extended by the root, tasks or gateway. At or after the bound
time they drop both directions for new and already-open sockets. Effect 9 verifies the
drop, exits/reaps the helper and closes all four duplicated control handles. The helper dies on
root-custodian loss, and its accepted cgroup/pidfd identity is an exact cleanup anchor at every cut
after spawn, each mutation, capability drop, exit and reap. The root re-attests both exact policy
bytes and zero surviving egress-mutation authority before each later credential transfer. A live
helper, capability, writable control handle or policy drift refuses and enters cleanup-only.

Only after that seal may the root instantiate four independently measured, credentialless tasks
behind one trap each: the containment supervisor, control relay, database relay and observer. The
observer has a distinct non-login uid/gid, executable/runtime identity, descriptor table and
evidence-channel peer identity; it shares only the sealed containment, never another relay's secret
handle. Each `acquire_and_queue_*_credential` effect binds the authorized credential-resource
digest, exact stopped recipient task/pidfd and authenticated one-use receive-socket identity. The
guarded credential broker transfers the secret descriptor directly into that recipient's kernel
queue after the intent is durable. The root, coordinator and setup helper receive only the signed
lease/queue receipt and never own a readable secret descriptor; acquisition and queued delivery are
one indivisible effect, so no intermediate secret owner or fictional delivery step exists.

The broker is a separately installed, persistent guarded service rather than an operation-owned
task. Both bridge policies, the broker's own installed policy and the signed authorization pin its
response signer, request-verification public key/signature domain, measured executable, immutable
runtime/rootfs, local peer uid/gid/cgroup/runtime policy and exact one-shot protocol. The same policy
pins an immutable digest-to-store-resource map and the store leg's exact host, numeric-address set,
DNS resolver/transcript policy, TLS trust/server identity/SNI/ALPN, protocol, method and path set,
proxy prohibition, zero redirects and default-deny route policy. Its namespace has only those
store addresses and no target/provider/Amazon route.

`RegisteredPreparationAuthorityV2::acquire_and_queue_credential` is the only broker dispatcher and
accepts only synced intents 11, 12 or 13. It uses the already authenticated authority-internal
broker control. Only after consuming the intent, it sends the fixed `OPEN_NONCE_CHANNEL` frame; the
broker first syncs `ABSENT -> CHANNEL_OPENING`, creates a genuinely new connected
`AF_UNIX SOCK_SEQPACKET` socket pair and transfers one nonce-tagged root end with `SCM_RIGHTS`.
The root calls `recvmsg(MSG_CMSG_CLOEXEC)`, rejects a duplicate file description, wrong socket
type/state, extra queued record/fd, wrong peer/cookie/nonce or missing `FD_CLOEXEC`, then returns the
fixed `CHANNEL_RECEIVED` acknowledgement. Only after that acknowledgement is synced as
`CHANNEL_READY` does the independently closable per-nonce connection count as `D1`. `dup` of the
retained control is forbidden and is not a subchannel. The effect code selects the authorization-bound resource, recipient and nonce; the
method accepts no caller resource, locator, recipient or request bytes. It constructs and signs the
distinct-domain broker request inside root custody, authenticates the single broker reply and
commits that effect's `accepted` or `no_accept` plus `closed` records before returning bounded
status. Generic `record_accepted`/`record_no_accept` refuse these three effect codes.

`reconcile_credential` is the only lost-response broker path. It accepts only effect code 11, 12 or
13 when that exact current intent is unclassified, derives the operation/nonce/recipient entirely
from the journal and uses the retained authenticated control channel. Its distinct signed
`openspell.credential-broker-reconcile.v1` status/abort request cannot name or open a resource,
create a store route, deliver a descriptor or change a terminal nonce. The broker closes that
nonce's existing `D1 U1 R1 V4` and pre-queue `C1 S1` custody, if any, before answering. Exact prior
delivery permits the root to record accepted `+C1 +S1`; authoritative non-delivery with all custody
closed permits `no_accept`; anything else stays uncertain. The method commits classification and
closure before returning and never signs or sends the acquisition request again.

Acquire and abort share one linearizable per-nonce state machine:

```text
ABSENT -> CHANNEL_OPENING -> CHANNEL_READY -> ACQUIRING -> DELIVERY_UNCERTAIN -> DELIVERED
ABSENT | CHANNEL_OPENING | CHANNEL_READY | ACQUIRING -> ABORTING -> NOT_DELIVERED
```

At a live-process `CHANNEL_OPENING` cut, reconciliation must boundedly drain and authenticate the
exact nonce-tagged open-channel record with `MSG_CMSG_CLOEXEC`, close any received root end, prove
the retained control receive queue empty and return a root closure acknowledgement before the
broker closes its peer. After root-process death, the proof bootstrap and broker must instead prove
destruction of the exact old control socket and ancillary queue before a new control channel can
reconcile it. `ABSENT|CHANNEL_READY|ACQUIRING` may durably CAS to `ABORTING`; after the special queue-drain proof,
`CHANNEL_OPENING` may do the same. It closes exact `C1 S1 D1 U1 R1 V4` custody, syncs the terminal
`NOT_DELIVERED` tombstone and only then answers.

Immediately before attempting secret `sendmsg`, the broker must sync
`ACQUIRING -> DELIVERY_UNCERTAIN`. Neither abort nor reconciliation may transition
`DELIVERY_UNCERTAIN` to `NOT_DELIVERED`. Exact recipient acknowledgement may transition it to
`DELIVERED`; otherwise recovery terminates and inventories the exact still-stopped recipient (and,
under the group invariant, the complete still-stopped task set), closes all broker/control/recipient
custody and leaves the original effect unclassified and the operation permanently recovery-only.
Every delayed acquisition frame observes the non-`ABSENT` state and refuses without secret lookup
or delivery. No reply permits the root to journal `no_accept` before the terminal tombstone is
synced, and no uncertain delivery cut can serialize `no_accept` or success.

Each canonical request is signed by the registered root authority over
`openspell.credential-broker-request.v1\n<canonical-request>\n`, arrives over the policy-pinned
authenticated local peer, and binds the complete root authorization digest, exact mapped resource
digest, operation lease nonce, expiry, stopped recipient pidfd/start and peer socket. Before secret
open, the broker performs the `CHANNEL_READY -> ACQUIRING` transition above; an expired, mismatched
or differently staged nonce refuses without lookup, and crash recovery may only abort or finalize
that same entry. The broker's measured process and nonce record are therefore part
of the effect recovery anchor before it opens the resource. It accepts no resource name, locator,
endpoint, DNS answer or route from the request.

From `CHANNEL_OPENING` until accepted/no-accept classification, each broker effect accounts for at most
one local control connection (`D1`), one store connection (`U1`), one resolver socket (`R1`) and four
deadline/I/O/DNS/TLS watchers (`V4`). These are per-nonce handles, not uncounted persistent-service
infrastructure. The nonce registry and measured broker pidfd make every handle discoverable; success
and authoritative no-accept require all four transient classes closed. An uncertain cut contributes
their full maximum-positive delta until reconciliation closes them and proves either exact queue
acceptance or nonoccurrence.

It opens only the mapped resource, counts its pre-queue descriptor as `S1`, sends one sealed
descriptor by one `SCM_RIGHTS` record, and requires the stopped recipient to call
`recvmsg(MSG_CMSG_CLOEXEC)`, verify exactly one descriptor plus `FD_CLOEXEC`, and close/refuse it
before arming if either property fails. The sender also holds its copy with `FD_CLOEXEC`. The broker
proves the recipient accepted exactly one descriptor, zeroizes its buffer, closes its copy, durably
marks the nonce `DELIVERED` and returns one signed receipt. A crash before
`DELIVERY_UNCERTAIN` leaves abortable broker custody; a crash from that transition through the
durable recipient acknowledgement follows the permanently fail-closed uncertain-delivery rule
above. It cannot accept
a caller resource name or endpoint. The operation broker lease and secret descriptor are exactly
the effect's `C1 S1`, regardless of which of those two custody states is current, and the broker
attests zero retained operation handles after the corresponding close effect. Runtime substitution,
restart, extra descriptor/record, retention or target reachability refuses.

The durable nonce registry retains exactly one secret-free terminal tombstone for each of the three
requests. Each canonical tombstone binds authorization/operation/resource/recipient/nonce digests,
`delivered|not_delivered`, terminal custody digest, request expiry and broker signature; it holds no
locator, credential or open handle. Success requires the signed three-record tombstone-set digest in
the closed inventory. A tombstone is retained until at least 600 seconds after its request expiry.
Only then may the broker's trusted-clock GC append a signed `expired_gc` transition and compact its
detailed record into the append-only spent-nonce accumulator. Publication of the accumulator leaf
and new signed root is synced before the detailed record is removed; a nonce is never absent or
reusable, even after clock rollback or GC. These broker-internal replay tombstones/spent commitments
are one approved retained class, not ephemeral resource residue, and their handles remain outside
the operation resource vector.

`RegisteredPreparationAuthorityV2::release_gateway_and_observer` consumes effect 14's synced
intent without detaching a permit from the registered authority. The authority retains the
operation's trusted monotonic deadline, blocked-signal `signalfd`, deadline `timerfd`, cleanup-only
latch, every task pidfd and the group-release state. It owns exactly four identity-bound duplex
`SOCK_SEQPACKET` controller ends, one read-only sealed descriptor containing the complete policy,
operation, task-set and release-nonce digest record, and the sole writable mapping of a separate
aligned atomic `u32` state. Each task has only its duplex peer, the sealed record opened read-only,
and a read-only mapping of the atomic state; it drops the backing state descriptor and a fixed
seccomp policy prohibits `mprotect`, new mappings and descriptor recovery before it can arm.

Each stopped task verifies the sealed record, accepts one fixed 32-byte arm token over its
authenticated duplex channel, returns one bounded `armed` acknowledgement binding its immutable
pidfd/start/runtime identity and the full sealed-record digest, then waits while the atomic state is
`WAITING`. The authority verifies all four acknowledgements, rechecks the trusted monotonic deadline,
pending signal channel, cleanup latch, pidfds and exact state immediately before a single
release-order compare-exchange from `WAITING` to `COMMITTED`, then wakes all waiters. Each task uses
an acquire load, re-verifies the sealed record and reads the bound kernel monotonic clock before any
instruction past the trap. At or after the sealed `releaseNotAfterBootTimeNs`, it exits without
using its queued credential even if it observed `COMMITTED`. The gateway/observer seccomp and state
machines cannot open a target socket, consume a credential or acquire an attestation/phase lease
until a later root grant performs its own fresh signal/deadline/cleanup check.

Deadline, signal and cleanup paths compete through the same authority-owned compare-exchange from
`WAITING` to the terminal `REVOKED` state; after `REVOKED`, no object can commit. The CAS is the
explicit revocation/commit linearization point: raw `signalfd`/`timerfd` readiness is not itself
described as revocation. If `COMMITTED` linearizes first, a concurrently arriving signal still
permanently disqualifies success and kills the group, while the independent task-side absolute
deadline and later root-grant checks prevent post-deadline target access. If `REVOKED` linearizes
first, no task may pass the trap. No caller or detached thread possesses a writable mapping or
commit capability.

This root-produced effect authenticates no external evidence channel: the method itself commits
effect 14's `accepted` or `no_accept` record and its `closed` record before returning bounded status.
If the process or response is lost, reconciliation reads only the atomic-state identity and the
four acknowledged pidfd/start identities already bound in the intent; it never repeats the compare-
exchange or returns a new release capability.

EOF, HUP, extra/malformed bytes, root-custodian death, a missing acknowledgement, mapping-policy
mismatch or state mismatch terminates every task. The custodian holds every pidfd plus
`PTRACE_O_EXITKILL` and cgroup-kill authority until all four runtime handshakes are classified. A
crash, lost response or only one through three armed tasks kills/reaps the full set, never retries,
and remains recovery-only; no task can acquire a lease or session before the single group commit.
The four duplex traps, sealed binding record and atomic state object are the `V6` held from staging
through `close_gateway_and_observer_tasks`. After postflight, each credential close effect
first proves its recipient secret descriptor zeroized/closed and broker lease released. Only with
`C` and `S` both zero may `close_gateway_and_observer_tasks` reap the four task/pidfd identities.
The subsequent `close_gateway_containment_and_egress` closes the shared cgroup/cell/namespaces and
proves the sealed policy has no surviving authority. No process with a secret can ever observe the
host/default route.

An operation-scoped `AttestationLease` binds authorization, target generation, external window,
exact control request or observer query-corpus digest, relay/observer pidfd and runtime identity,
sealed containment/egress identities and hard expiry. It has no phase ticket or CLI identity and is
the only lease accepted by provider-control observation and observer pre/postflight. A
`PhaseGatewayLease` instead binds all of those common facts plus the exact phase ticket,
`executing` transition, CLI pidfd/start identity, cgroup, network namespace and exec graph. It is
the only lease accepted by history-fetch or dry-run traffic. The two canonical lease schemas and
signature domains are disjoint; neither decodes as the other. Both count in the single `L`
resource component and close within their effect.

Every permitted connection has two separately authenticated TLS legs:

1. On the CLI-to-gateway leg, the root launcher installs one operation-private CA certificate in
   the measured CLI runtime and binds its digest into invocation, runtime and gateway policy. The
   gateway alone holds the private key. DNS inside the CLI network namespace maps only the exact
   authorized upstream hostnames to fixed gateway addresses. The gateway certificate SAN set is
   exactly those phase-authorized hostnames. No caller CA, system-trust extension, alternate API
   base or proxy variable is accepted.
2. On the gateway-to-upstream leg, the gateway resolves the exact authorized hostname, validates
   every answer and CNAME, connects to the validated numeric address, and verifies WebPKI TLS for
   that hostname. SNI, HTTP Host, target reference, resolution and connected peer must agree. It
   rejects loopback, private, link-local, multicast, metadata, IPv4-mapped and disallowed
   IPv6/NAT64 destinations. Plaintext and TLS downgrade refuse on either leg.

The control gateway terminates downstream TLS, requires exactly the phase surrogate, substitutes
the retained upstream bearer only after lease and peer verification, and forwards only the policy's
method, host, path, header, body and response shapes. Redirects, cookies, extra authentication
forms, unknown status classes and body overflow refuse and close the lease.
Independently of the packet gate, every gateway/observer state transition checks the bound kernel
monotonic deadline before DNS, connect, TLS handshake, socket read/write and each HTTP/PostgreSQL
message read/write. The deadline watcher closes both legs and the lease automatically at expiry.
A held connection crossing the boundary must yield zero ingress/egress packets admitted at or after
the bound kernel timestamp and zero later protocol operation; tests exercise the exact boundary.

The PostgreSQL gateway is a one-to-one protocol translator, not a SQL filter. It accepts exactly an
SSLRequest followed by TLS; one bounded StartupMessage with the fixed database, user and encoding;
surrogate downstream authentication; upstream authentication with the retained scoped database
credential; and gateway replacement of client `application_name` with the exact operation, nonce
and phase tag. One downstream connection maps to one upstream connection and one backend pid/start
identity. Pooling, reuse, multiplexing, fan-in, fan-out and cross-phase backends refuse. Every
message, row and error is bounded. A CancelRequest is allowed only if the final executable policy
proves its exact separate connection and key mapping; otherwise it refuses the external proof. Both
legs close together.

The CLI-to-database evidence is one signed, nonmultiplexed chain:

```text
exact CLI process/cgroup/netns
  -> one downstream connection
  -> one gateway lease
  -> one upstream socket
  -> one target backend pid/start and gateway-selected phase tag
```

`application_name` is diagnostic only because a PostgreSQL client can change it after startup. The
immutable census key is the exact non-role-switchable preparation login identity plus backend PID
and `backend_start`, bound at upstream authentication to the root-journal phase/ticket/lease. The
role has no membership or `SET ROLE` capability. History and dry run are strictly sequential, and
the external window proves no other actor can use that login. Observer queries scan every session
for the preparation login whether its application name is correct, changed, empty or truncated. A
mismatch present at a sample is recorded, but the proof does not claim to detect a transient change
restored between samples and does not use that mutable field for absence or identity. The observer
login has its own distinct immutable identity. If the provider cannot expose lossless
login/PID/backend-start facts, external proof is a no-go.

The gateway runs under a dedicated non-login uid/gid with empty capability sets, `no_new_privs`,
dumpability disabled after every exec, core limit zero, bounded locked secret buffers, no
swap-backed secret storage, `O_CLOEXEC` on every descriptor, no fork/exec after secret intake and a
fixed seccomp/network policy. Raw secrets arrive only over a pre-opened authenticated private
handle, never enter argv, environment, files or logs, and are zeroized before descriptor and process
closure. Terminal evidence includes gateway memory-lock, zeroization and descriptor inventories.

Proxy variables, `PATH`, loader/debug overrides, alternate API bases, linked/local targets and
direct database URLs are absent. If the exact official CLI cannot use these two TLS legs, requires
an unsupported protocol branch, bypasses the gateway, opens an unbound connection or cannot use the
non-writing role, external proof stops and WP-202 remains blocked.

The credential-free acquisition helper has a separate fixed HTTPS host/method/redirect policy and
strips credentials at every hop. It publishes only into a root-owned descriptor destination and
must satisfy WP-200's fixed sizes, digests, archive rules and revalidation.

## Official runtime evidence scope

This source slice contains only types and synthetic policy fixtures. External policy closes in two
reviewed stages.

The discovery-policy addendum must land first. It pins a non-writing discovery harness and its
complete executable/runtime provenance; exact official release URLs and transfer bounds; one
disposable target authorization; existing minimum-scope credentials; gateway-only target routes;
operation-private TLS; `GET`/`HEAD`/`OPTIONS` control-plane methods only; the non-writing database
roles above; output/deadline/resource bounds; and zero lifecycle/write authority. Its only output is
a private bounded trace of attempted/observed methods, paths, TLS/ALPN, PostgreSQL messages,
exec/dependency graphs and failure classifications. The root journal records zero mutation and
resource closure. The discovery harness may fail; its evidence is review input and can never be
reused as an executable policy or preparation success.

After that authorized run, a reviewed architecture addendum first fixes the ignored adapter path,
interfaces and deny-live construction. The candidate implementation then lands and is measured
offline while the compiled policy still makes every external capability constructor refuse. It may
contain the fixed adapter mechanics but has no agent entrypoint, installed live policy, credential
or route. The final executable-policy addendum must pin those already existing candidate bytes and
all of the following:

- initial release URLs, HTTPS methods, redirect count and exact redirect-host set, plus transfer,
  header, body and time bounds;
- the existing WP-200 release/archive/binary facts and the immutable runtime-base OCI index,
  platform manifest, configuration and layer digests, or an equivalent immutable rootfs source;
- platform selection, layer and whiteout reconstruction, and the complete selected-root inventory
  including loaders, dependencies, CA, resolver, locale and timezone bytes, owners, modes and links;
- operation-private gateway CA placement/digest, both TLS legs' versions, ALPN and certificate
  policy, and exact per-phase HTTP/PostgreSQL protocol tables; and
- the complete expected history-fetch and dry-run exec graphs;
- the broker request-verification key/domain, local peer/cgroup identity, durable nonce state
  machine, immutable resource map, and credential-store host/address/DNS/TLS/server/protocol/
  proxy/redirect/route policies;
- source revision, reproducible build inputs/toolchains, binary digest, interpreter/dependencies and
  complete immutable runtime-root inventory in the subordinate manifest for the acquisition helper,
  root custodian, credential-broker client, credential gateway, observer and ignored external
  adapter; and
- descriptor-relative pre-secret measurement and expected process/cgroup/namespace topology for
  every privileged executable, including the exact Node/runtime bundle if the adapter is a script.

The bootstrap verifier/root launcher and its immutable runtime/rootfs must already be pinned by the
separately reviewed nondeployable proof-bootstrap record and are deliberately excluded from the
subordinate manifest they authenticate. The final review verifies both layers, the append-only
activation registry and their one-way linkage; neither layer lists or hashes itself. WP-203 later
creates the separate deployable installer pin after WP-202 rather than serving as an earlier gate.

None may come from a caller, environment, mutable tag, host path, package cache, package-manager
transaction or discovery fallback. A missing constant, unexpected redirect/object/dependency/
protocol branch or incomplete graph is a no-go. Every privileged executable is measured from its
held descriptor before network or secret release; a matching source revision alone is insufficient.
After the final policy merges, execution releases only a separately authenticated, one-use
disposable-target capability to the unchanged candidate. No post-policy source, binary, dependency
or runtime change is permitted; any changed byte requires a new measured candidate and policy.

WP-201 may complete only preparation-scoped evidence for:

- official source acquisition;
- interpreter, dependency and complete runtime-image inventory;
- the official history-fetch exec graph; and
- the official dry-run exec graph.

The runtime root comes from an immutable reviewed artifact graph, not host libraries, `apt`, a
package cache, user download, mutable image tag or caller path. Every file, directory, loader,
dependency, CA/resolver/locale input, owner, mode, link and mount is inventoried; extras refuse.

WP-201 must not claim WP-197's final all-phase `nativeRuntimeIdentitySha256` or
`releaseProvenanceSha256`: the apply graph has not run. It emits explicitly versioned,
preparation-scoped official evidence. WP-202 remeasures freshness-sensitive facts, proves the third
phase and alone may close the all-phase identity.

## Fixed phase vocabulary

The only operational phase type is:

```text
HistoryFetch | DryRun
```

There is no third variant, optional dry-run boolean, generic subprocess, write capability or
approval/execution ticket. The fixed dry-run vector structurally contains `--skip-vault` and
`--dry-run`; removal, duplication, reordering or option termination before either flag refuses
before spawn. The write-incapable database identity and gateway closure remain stronger than flags.

History must close completely before the dry-run ticket can exist. Each phase gets a distinct
Ed25519-signed, single-use preparation ticket with `writeCapability: false` and exact operation,
nonce, target, runtime, invocation, sandbox, topology, cgroup and session bindings.

## State-root registry and preparation journal v2

The already-open state-root descriptor has this exact inventory:

```text
AUTHORITY_SUPER_LOCK
AUTHORITY_REGISTRY/
  FORMAT
  objects/records/<sha256>
  objects/signatures/<sha256>
  transitions/<20-digit-generation>-<sha256>.json
exactly one of:
  ROOT_JOURNAL_V1/
  PREPARATION_JOURNAL_V2/
```

Only the journal selected by the registry may exist; the other directory must be absent.
`AUTHORITY_SUPER_LOCK` is a root-owned, mode-`0600`, link-count-one regular file on the same local
filesystem. Every externally composable v1 or v2 open first takes its non-waiting exclusive OFD
write lock and retains it for the authority lifetime. Registry files are immutable and content-
addressed. Registry and v2 publication deliberately use the v1 direct-final discipline: create the
final name with `O_CREAT | O_EXCL`, write completely, verify metadata, sync the file, sync its
containing directory and reopen/reverify the complete inventory. There is no temporary name or
rename cut. An empty, partial or otherwise unreferenced final-name artifact is recovery-only. The
v1 publisher, publication ordinals, bytes and recovery classifications remain unchanged. `FORMAT`
is exactly
`openspell.hosted-migration-authority-registry.v1\n`; the generation-zero predecessor is
`dfe1ba8e9380db530e4d8847e8169cf919455cb25df9734bdab34def9ba8f0c7`. Each registry record has this
exact canonical key order:

```json
{
  "schemaVersion": "openspell.hosted-migration-authority-registry.v1",
  "registryGeneration": 1,
  "previousRegistryRecordSha256": "dfe1ba8e9380db530e4d8847e8169cf919455cb25df9734bdab34def9ba8f0c7",
  "activeFormat": "preparation_v2",
  "activeJournalName": "PREPARATION_JOURNAL_V2",
  "activeJournalIdentitySha256": "...",
  "authoritySuperLockIdentitySha256": "...",
  "installationAuthorizationSha256": "...",
  "installationAuthorizationSignatureSha256": "...",
  "boundStateRootIdentitySha256": "...",
  "preparationPolicySha256": "...",
  "proofBootstrapRegistrySha256": "...",
  "proofBootstrapVerifierIdentitySha256": "...",
  "proofBootstrapManifestSha256": "...",
  "proofBootstrapLockIdentitySha256": "...",
  "sourceRevision": "...",
  "privilegedExecutablePolicySha256": "...",
  "privilegedExecutablePolicyGeneration": 0,
  "activeTargetFingerprint": null,
  "activeTargetGeneration": 0,
  "otherFormatDisposition": "absent",
  "otherFormatTerminalTransitionSha256": null,
  "installedAt": "...",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

Its domain is
`openspell.hosted-migration-authority-registry-signature.v1\n<canonical-unsigned-registry>\n`.
The unsigned canonical registry omits only the final `detachedSignatureSha256` key; every earlier
key remains in the displayed order. The registry signing and verification key is the installed
policy's `credentialBrokerRequestVerifierPublicKeyHex`, also used by the confined root authority
for authenticated broker requests. `issuerPublicKeySha256` is SHA-256 of that raw public key.
Before generation one, the installer retains the complete canonical installation-authorization
record at `objects/records/<installationAuthorizationSha256>` and its raw signature at
`objects/signatures/<installationAuthorizationSignatureSha256>`. Those two digests must equal the
record's own complete-record digest and `detachedSignatureSha256`; neither object is a registry
generation or transition. The generation-one registry record binds those two objects, the verified
state-root identity, exact policy digest and complete proof-bootstrap/source/executable-policy
tuple displayed above. A restart verifies the retained authorization with the policy's
`rootIssuerPublicKeyHex`, verifies every bound value against the supplied installed-policy and
bootstrap capabilities and verifies that its registry-signer digest equals the registry issuer
before reconstructing the exact fresh, active or closed state-specific root capability. Generation
two repeats every installation, policy, bootstrap, state-root and executable-policy field
byte-for-byte.
The raw 64-byte signature is retained only at
`objects/signatures/<detachedSignatureSha256>`; the complete record is retained at
`objects/records/<recordSha256>` and repeated byte-for-byte as its transition filename payload.
The registry tree contains exactly `FORMAT`, `objects/records`, `objects/signatures` and
`transitions`; it has no inner lock because `AUTHORITY_SUPER_LOCK` serializes every registry open
and mutation. Its root and directories are mode `0700`; `FORMAT`, record files, signature files and
transition files are mode `0600`, regular, link-count-one entries owned by uid/gid zero on the
state-root device. Transition names are exactly
`<20-digit-generation>-<lowercase-64-hex-sha256>.json`.
The registry admits at most two transitions, three records, three signatures, 16,384 bytes per
canonical record and 262,144 total bytes including the repeated transition payloads and `FORMAT`.
Its inventory digest domain is
`openspell.hosted-migration-authority-registry-inventory.v1\n`. Generation one publishes exactly
five distinct direct-final files in this order: installation-authorization signature,
installation-authorization complete record, registry signature, registry complete record and
repeated registry transition. Generation two publishes exactly three: registry signature, registry
complete record and repeated registry transition. Any content-address collision or attempted object
alias refuses. Tests cut each ordinal after final-name creation, partial write, complete write,
metadata verification, file sync and containing-directory sync, plus after complete-inventory
reopen verification.
Registry and v2 recovery never infer whether a prior `fsync` call returned. When the final
transition name contains complete canonical, cryptographically valid bytes and every referenced
object is complete, the inspector may perform only durability completion: sync the transition file,
then every verified referenced record/signature file, then their containing directories and the
transition directory, and finally reopen and reverify the entire inventory before granting
authority. This writes no content, creates no entry and cannot make partial or invalid bytes valid.
A zero-length, partial, noncanonical, invalidly signed or missing-reference transition remains
permanently recovery-only. Crash tests include complete referenced bytes whose prior file-sync
outcome is unknown. The v1 scanner and its existing recovery classifications are unchanged.
Startup scans the complete strictly consecutive chain and verifies every predecessor, record hash,
signature object and signature before trusting the last generation. Fork, gap, orphan, overwrite,
or extra object is recovery-only. A coherent rollback that removes one or more complete suffix
generations together with every exclusively referenced object is outside this local-filesystem
threat model: no hash chain can detect rollback of its own complete storage domain. The disposable
proof assumes a root-owned local filesystem that is not snapshot-rolled-back by a privileged host
administrator. WP-203 must add an independently anchored monotonic counter before claiming
rollback resistance across privileged offline snapshot restore.

Registry generation one is installation and has `activeTargetFingerprint: null`,
`activeTargetGeneration: 0`, `otherFormatDisposition: "absent"` and a null other-format terminal
digest. `activeFormat` is exactly `root_v1` or `preparation_v2`; `activeJournalName` must respectively
be `ROOT_JOURNAL_V1` or `PREPARATION_JOURNAL_V2`. No other enum pair decodes. WP-201 installs only
`preparation_v2`; a separately installed `root_v1` selection is recovery-only to its coordinator.
The other journal directory must be absent, so `otherFormatDisposition` has no second WP-201 value
and its terminal digest is always null. The installation-authorization, state-root, policy,
bootstrap, source and executable-policy bindings are immutable across the chain. For the single
disposable operation, generation two is the
only target-binding compare-and-set: it changes null/zero to the authorization-bound lowercase
64-hex fingerprint and target generation one. No third registry generation is legal in WP-201.
Closure does not append to the registry: generation two already retains the target tuple as replay
history, and the v2 journal independently reduces to `closed`. A generation-two registry plus an
exactly closed v2 journal is therefore the read-only terminal condition, with no cross-store crash
interval.

`activeJournalIdentitySha256` is the lowercase SHA-256 of
`openspell.hosted-migration-journal-identity.v1\n<canonical-identity>\n`. The canonical identity key
order is `schemaVersion`, `activeFormat`, `activeJournalName`, `filesystemDeviceDecimal`,
`inodeDecimal`, `ownerUid`, `ownerGid`, `modeOctal`, `formatSha256`. Device and inode are nonempty
ASCII decimal strings without leading zeroes; `schemaVersion` is exactly
`openspell.hosted-migration-journal-identity.v1`; production `ownerUid` and `ownerGid` are unsigned
JSON integer zeroes; `modeOctal` is the string `0700`. The format digest is SHA-256 over the exact
`FORMAT` bytes: `72bfa677e453b8e77492ee2d0d15b9041f31986410e00a02d374cc3d60c3c1b5`
for `root_v1` or `25b0ecf781f361559c6e59297b4caacbda88742c63bdd28a53cd2a9cc0b4a16a`
for `preparation_v2`. The identity is derived from the already-open journal directory and its
verified `FORMAT`, never from caller bytes, and its pathname entry must be revalidated against the
held fd before every registry or journal publication and again before success. Every registry hash
and signature field is lowercase 64-hex. `installedAt` is the authenticated time of that registry
append in canonical millisecond UTC form and is nondecreasing across the chain despite its
historical field name.

`authoritySuperLockIdentitySha256` is unchanged across the registry chain and is SHA-256 of
`openspell.hosted-migration-authority-super-lock-identity.v1\n<canonical-identity>\n`. The canonical
key order is `schemaVersion`, `filesystemDeviceDecimal`, `inodeDecimal`, `ownerUid`, `ownerGid`,
`modeOctal`, `linkCount`, `sizeBytes`; the schema is
`openspell.hosted-migration-authority-super-lock-identity.v1`, device/inode use the decimal-string
rules above, owner uid/gid are unsigned integer zeroes, mode is `0600`, link count is one and size is
zero. Installation derives it from the newly created, already locked fd. Every later opener first
takes the offered inode's non-waiting OFD lock, then refuses unless the registry's signed identity
equals that held fd and its pathname entry. Replacing the lock path therefore cannot create a
second accepted lock domain even if the incumbent has not yet reached its next revalidation.
Before target quarantine, a locked compare-and-set replaces `null`/zero with the exact target
fingerprint and target generation one. Closure leaves that immutable generation-two tuple in place
as replay history and never rewrites or appends a registry record. The signed registry therefore
arbitrates both format and target generation. Missing/extra
files, lock contention, a detectable incomplete suffix, a second journal, an unknown format or
nonterminal other-format state enters recovery-only before entropy, signing or mutation. Coherent
offline suffix rollback has the explicit limitation above.

This proves one authority only within the supplied state root. It does not prove a second root is
absent elsewhere on the host. WP-203 must establish one installed state-root descriptor and one
credentialed supervisor authority before any deployable artifact exists; until then “host-global”
is deliberately not claimed.

The external disposable proof requires a newly provisioned isolated proof host/root whose registry
selects `preparation_v2` and proves v1 absent. Initialization is a distinct root installation
capability that may act only on an already-open, completely empty, root-owned mode-`0700` directory
on the approved local filesystem. Production ownership is fixed to uid/gid zero; alternate
ownership exists only in `cfg(test)` synthetic constructors and cannot reach the bridge. Source
acceptance exercises the unrelaxed bridge-success path only as uid/gid zero inside the isolated
root proof container defined below; ordinary local non-root tests do not satisfy that row. The
installer validates the complete installed policy, held bootstrap lease/current tuple, canonical
installation authorization and root-issuer signature, registry-signing public component,
state-root identity and trusted-clock identity before it creates the first child. Its initial
authenticated realtime/`CLOCK_BOOTTIME`/boot-id tuple maps `expiresAt` to an absolute
`CLOCK_BOOTTIME` deadline; an already expired authorization refuses without mutation. Expiry
authorizes initiation of this single bounded installation attempt; once mutation starts, expiry
cannot turn an otherwise complete signed installation into an adoptable-but-refused tree. The
installer syncs the empty root, creates and syncs `AUTHORITY_SUPER_LOCK`, takes its OFD lock, creates
and syncs the complete v2 journal, creates and syncs the complete registry, publishes registry
generation one in that order. Immediately before creating the generation-one transition final name,
it revalidates the held bootstrap/current tuple, root, super-lock, journal, registry objects, signer
and clock descriptors, requires the local boot id unchanged and `CLOCK_BOOTTIME` strictly before
the derived deadline, then performs no further authority decision. After final-name creation, any
publication, sync, reopen or verification error is an uncertain commit outcome rather than a
refusal. A successful containing-directory sync followed by complete reopen verification returns
`StateRootInstallationOutcomeV1::Installed`; any post-final-name I/O or verification failure returns
`StateRootInstallationOutcomeV1::CommitOutcomeUnknown`, after consuming and dropping every
held descriptor/capability. The caller must acquire a fresh policy/bootstrap lease and root
descriptor and recover only through `inspect_fresh_preparation_state_root`. That inspector applies the
observable durability-completion rule above: a complete valid transition becomes installed after
sync/reverify, while partial or invalid bytes are permanently recovery-only. No post-final-name path
returns `PreparationRefusal`. Directory creation is
followed by parent-directory sync; file publication follows the direct-final discipline above. The
supplied state-root directory is the parent being synced; the installer does not create or accept an
outside pathname. A cut before the first child exists may be retried. Any validation failure,
expiry or cut after the first child but before final-transition creation is permanently
recovery-only and requires reprovisioning a different disposable root. A cut after final-name
creation is outcome-unknown and resolves only by the inspector rule above. Open never deletes,
overwrites or repairs content. There is no v1-to-v2 upgrade. A registry selecting v1 gives the
WP-201 coordinator only `legacy_v1_recovery_only`.

The v2 journal tree is exactly:

```text
FORMAT
LOCK
objects/
  records/
  signatures/
transitions/
```

Its `FORMAT` bytes are exactly
`openspell.hosted-migration-preparation-journal.v2\n` (SHA-256
`25b0ecf781f361559c6e59297b4caacbda88742c63bdd28a53cd2a9cc0b4a16a`). Its generation-zero
predecessor is
`e7ebfa2198a1417a28ff4be3a4c34bb6dc1d37acd9d81da7fcd4007c0a2c1222`, defined as SHA-256 of
`openspell.hosted-migration-preparation-journal-genesis.v2\n`. Its inventory digest domain is
`openspell.hosted-migration-preparation-inventory.v2\n`. Transition names use the same exact
20-digit/lowercase-digest grammar as the registry, but the namespaces and decoder remain statically
v2. The root and all directories are mode `0700`; `FORMAT`, `LOCK`, record files, signature files
and transition files are mode `0600`, regular, link-count-one entries on the root device. `LOCK` is
empty and held after the super-lock in fixed lock order. The journal permits at most 4,096 transitions,
12,288 records, 16,384 raw 64-byte signatures, 16,384 bytes per canonical record and 64 MiB for the
complete tree. Step 3 exposes no production append and accepts only the verified empty v2 tree;
the registry and unchanged v1 paths exercise the shared direct-final publication kernel. Before
step 4 implementation begins, a separately reviewed contract amendment must fix every remaining
v2 milestone/terminal record schema, transition decoder and record-signature domain; none may be
invented in code.

No v2 file may enter a v1 tree. The v1 storage implementation's canonical publication primitives
become format-generic only behind sealed crate-private compile-time traits. The shared kernel may
open, verify, index, publish and revalidate immutable bytes; it never selects a runtime format,
decodes a transition, reduces state, signs, draws entropy or exposes a generic append. V1 retains
its exact `objects/leaves` namespace, format, genesis, inventory domain, limits, direct-final
publisher and reducer. Default-feature and `wp201-internal` tests must produce identical v1 bytes,
hashes and classifications for every clean, terminal, nonterminal, corrupt, forked, orphaned,
permission-drift and unknown-transition fixture. Cross-process v1/v2 races prove one super-lock
owner and zero loser-side files, entropy or signatures.

Every production open derives uid/gid zero from compiled installed policy rather than accepting
ownership from its caller. It retains the state-root dirfd, super-lock fd and selected-journal lock
fd. Immediately before each publication and before returning success it revalidates root identity,
the selected journal pathname-to-fd identity, super-lock pathname-to-fd identity, owner, mode,
link-count and device. Replacement, unlink, rename, hard-link or metadata drift seals the authority
recovery-only. `F_OFD_SETLK` failure has no `flock` or POSIX-lock fallback. Destruction closes journal
mutation/signing capabilities before dropping the super-lock, so no contender can enter during
teardown.

WP-201 does not put preparation-scoped evidence into the unchanged WP-197/WP-198 v1 ticket. Its
ticket is exactly this canonical v2 record:

```json
{
  "schemaVersion": "openspell.hosted-migration-preparation-ticket.v2",
  "ticketNonce": "...",
  "operationId": "...",
  "authorizationNonce": "...",
  "phase": "history_fetch",
  "writeCapability": false,
  "targetFingerprint": "...",
  "targetSelectionSha256": "...",
  "disposableTargetPermitSha256": "...",
  "targetQuarantineGeneration": 1,
  "targetQuarantineEvidenceSha256": "...",
  "externalExclusiveWindowGeneration": 1,
  "externalExclusiveWindowEvidenceSha256": "...",
  "preparationOfficialSourceEvidenceSha256": "...",
  "preparationRuntimeIdentitySha256": "...",
  "phaseExecTopologyPolicySha256": "...",
  "childSandboxPolicySha256": "...",
  "childCgroupPolicySha256": "...",
  "phaseInvocationV2EvidenceSha256": "...",
  "credentialScopeEvidenceSha256": "...",
  "gatewayPolicySha256": "...",
  "egressPolicySha256": "...",
  "phaseSessionTagSha256": "...",
  "phasePrerequisiteEvidenceSha256": "...",
  "issuedAt": "...",
  "expiresAt": "...",
  "state": "prepared",
  "issuerPublicKeySha256": "...",
  "detachedSignatureSha256": "..."
}
```

Its signing domain is
`openspell.hosted-migration-preparation-ticket-signature.v2\n<canonical-unsigned-ticket>\n`.
Only `history_fetch` and `dry_run` decode; `writeCapability` is always false. The history prerequisite
binds target attestation, held quarantine/window, preparation runtime, scope and gateway/egress
policies. The dry-run prerequisite additionally binds the committed history result, independently
verified WP-197 bundle/workdir and observer preflight. A gateway lease is not predicted by the
ticket: after the `executing` transition it binds the ticket and transition digests to actual
pidfd/start, cgroup, namespace, socket, backend and expiry identities.

The v2 no-execution result has schema and signing domain
`openspell.hosted-migration-preparation-no-execution-result.v2` and repeats the operation, ticket,
phase, target and quarantine/window bindings. It accepts only `preparation_ticket_expired`,
`preparation_invariant_failed` or `preparation_launcher_rejected_before_execution` and requires
zero executing transitions, namespaces, cgroups, children, pidfds, credential deliveries, gateway
leases, downstream/upstream sockets, tagged sessions and watchers. A single locked compare-and-set
proves `prepared` never entered `executing`, publishes the signed result and enters
`terminal_no_spawn`. Any uncertainty remains recovery-only.

The legal successful milestone path is:

```text
empty -> intent_committed -> quarantine_and_window_held -> credentials_and_gateway_bound
  -> observer_preflight_committed -> target_attested -> official_runtime_bound
  -> history_prepared -> history_executing -> history_terminal
  -> history_evidence_committed -> bundle_evidence_committed
  -> dry_run_prepared -> dry_run_executing -> dry_run_terminal
  -> dry_run_evidence_committed -> no_change_postflight_committed
  -> observation_core_committed -> resources_closed -> conservation_committed -> closed
```

Public acquisition is a separately authorized predecessor operation and its helper, public egress
and temporary resources are proved closed before WP-201 operation intent. WP-201 receives only
already-open source/runtime descriptors. Credential leases and gateway policy bind before
provider/API/TLS/database observations.
Observer preflight then proves identity, privileges and the 41-version prefix; only then may
`target_attested` commit or a history ticket exist. Observer postflight begins only after the
dry-run child, cgroup, gateway lease and phase-tagged sessions are closed.

## Per-effect custody and conservation

Every material adapter operation uses exactly one of these protocols:

```text
effect_intent -> effect_no_accept -> effect_closed
effect_intent -> effect_accepted -> effect_closed
```

`effect_intent` binds operation, ordinal, fixed effect kind, lane, request digest, an immutable
recovery anchor, maximum signed resource delta and deadline and is synced before the adapter call.
`effect_accepted` binds the intent, exact immutable acceptance identities or release postcondition,
response digest and actual signed resource delta; a root custodian captures and syncs it before
returning a capability or starting the next effect. For an acquisition/read effect,
`effect_no_accept` requires authoritative nonoccurrence evidence. For a release effect it requires
authoritative evidence that the exact named resource remains live and unchanged. Silence is never
evidence. `effect_closed` settles the adapter interaction and binds its classification and
cumulative resource vector. A later release effect, identified by the accepted resource identity,
contributes the corresponding negative delta. There is at most one unclassified normal effect, and
no next normal effect begins until its protocol reaches `effect_closed`. The separately typed
cleanup-only lane follows the narrower release rules above and can never authorize normal
advancement. Multiple unclassified cleanup intents are permitted only for disjoint resource
identities; they all have zero maximum-positive delta and permanently preclude terminal success.

The four record schemas have these exact canonical key orders:

```text
openspell.preparation-effect-intent.v1:
schemaVersion, operationId, ordinal, effectKind, lane, requestSha256, recoveryAnchorSha256,
maximumPositiveDelta, maximumNegativeDelta, effectDeadlineMonotonicNanoseconds,
ownerBootIdSha256, previousEffectSha256, recordedAt, issuerPublicKeySha256,
detachedSignatureSha256

openspell.preparation-effect-accepted.v1:
schemaVersion, operationId, ordinal, effectKind, lane, intentSha256, acceptanceIdentitySha256,
responseSha256, actualDelta, ownerBootIdSha256, recordedAt, issuerPublicKeySha256,
detachedSignatureSha256

openspell.preparation-effect-no-accept.v1:
schemaVersion, operationId, ordinal, effectKind, lane, intentSha256, nonacceptanceEvidenceSha256,
actualDelta, ownerBootIdSha256, recordedAt, issuerPublicKeySha256, detachedSignatureSha256

openspell.preparation-effect-closed.v1:
schemaVersion, operationId, ordinal, effectKind, lane, classification, classificationSha256,
actualDelta, cumulativeLive, cumulativeUncertain, custodyClosureEvidenceSha256,
ownerBootIdSha256, recordedAt, issuerPublicKeySha256, detachedSignatureSha256
```

`ordinal` starts at one and is global across normal and recovery-cleanup records. `lane` is exactly
`normal` or `recovery_cleanup`; every record for one intent repeats it.
`effectDeadlineMonotonicNanoseconds` is a nonempty ASCII decimal string; all four records bind the
same boot-id digest. `classification` is exactly `accepted` or `no_accept`. Every delta/vector field
is the exact 23-integer array below. The accepted record's identity is a digest of a canonical typed
identity or postcondition list, never a mutable name. For every negative-delta release, it binds
both the prior accepted identity and authoritative terminal-absence/closure evidence. The no-accept
record uses the all-zero delta. Field, type, order, range or predecessor mismatch refuses before append.
The root signs each record over
`openspell.preparation-effect-<kind>-signature.v1\n<canonical-unsigned-record>\n`; raw signatures
remain in the v2 journal's content-addressed signature store.

The canonical resource delta is an array of 23 signed integers in this exact order:

```text
target_quarantines, external_windows, credential_leases, secret_descriptors,
gateway_instances, gateway_leases, execution_cells, cgroups, namespace_and_egress_control_handles,
owned_tasks, pidfds, downstream_sockets, upstream_sockets, resolver_sockets,
hosted_sessions, observer_transactions, output_collectors, watchers,
source_roots, runtime_roots, history_roots, bundle_roots, cli_roots
```

`live` is the element-wise sum of every classified accepted effect's signed delta. `uncertain` is
the element-wise sum of each unclassified intent's maximum-positive delta. There is at most one
unclassified normal intent; cleanup-only intents add zero positive uncertainty. Components never go negative
or exceed these caps:

| Resource | Maximum live |
|---|---:|
| target quarantine / external window | 1 each |
| credential leases / secret descriptors | 3 each |
| gateway instance / gateway lease | 1 each |
| execution cells / cgroups | 2 each |
| namespace and egress-control handles | 12 |
| owned tasks / pidfds | 64 each |
| downstream / upstream sockets | 2 each |
| resolver sockets / hosted sessions / observer transactions | 1 each |
| output collectors | 2 |
| watchers | 72 |
| source, runtime, history, bundle and CLI roots | 1 each |

The exact successful adapter-effect tape has 43 `normal`-lane accepted and 43 closed interactions, zero
`effect_no_accept` records, zero unclassified intents, and this order:

```text
acquire_source_root, acquire_runtime_root, close_source_root,
acquire_target_quarantine, acquire_external_window, create_gateway_containment,
stage_egress_setup_helper, install_and_seal_gateway_only_egress,
close_egress_setup_helper, stage_gateway_and_observer,
acquire_and_queue_control_credential, acquire_and_queue_preparation_credential,
acquire_and_queue_observer_credential,
release_gateway_and_observer, provider_control_observe, observer_preflight,
acquire_history_root, create_history_cell,
launch_history_child, history_gateway_roundtrip, close_history_child, close_history_cell,
verify_history, acquire_sealed_bundle, acquire_cli_root,
construct_and_verify_cli_workdir, create_dry_run_cell, launch_dry_run_child,
dry_run_gateway_roundtrip, close_dry_run_child, close_dry_run_cell, observer_postflight,
close_control_credential, close_preparation_credential, close_observer_credential,
close_gateway_and_observer_tasks, close_gateway_containment_and_egress,
close_runtime_root, close_history_root, close_bundle_root, close_cli_root,
close_external_window, close_target_quarantine
```

The table below is normative. Resource abbreviations follow the 23-vector order (`Q`, `W`, `C`,
`S`, `G`, `L`, `E`, `CG`, `N`, `T`, `P`, `D`, `U`, `R`, `H`, `O`, `OC`, `V`, `SR`, `RR`, `HR`,
`BR`, `CR`). Omitted components are zero; `max-` is a nonnegative release magnitude; `actual` is a
signed vector. Each anchor is a canonical typed identity digest.

| # | Effect kind | Recovery anchor type | max+ | max- | Successful actual |
|---:|---|---|---|---|---|
| 1 | `acquire_source_root` | pre-authorized source-root descriptor identity | `SR1` | — | `+SR1` |
| 2 | `acquire_runtime_root` | pre-authorized runtime-root descriptor identity | `RR1` | — | `+RR1` |
| 3 | `close_source_root` | accepted source-root descriptor identity | — | `SR1` | `-SR1` |
| 4 | `acquire_target_quarantine` | registry record + target generation | `Q1` | — | `+Q1` |
| 5 | `acquire_external_window` | signed window challenge + target generation | `W1` | — | `+W1` |
| 6 | `create_gateway_containment` | gateway parent-cgroup descriptor + cell nonce | `E1 CG1 N3` | — | `+E1 +CG1 +N3` |
| 7 | `stage_egress_setup_helper` | accepted containment cgroup + helper task nonce | `N4 T1 P1 V1` | — | `+N4 +T1 +P1 +V1` |
| 8 | `install_and_seal_gateway_only_egress` | accepted helper pidfd/start + gateway netns identity | `V1` | `V1` | — |
| 9 | `close_egress_setup_helper` | accepted helper pidfd + four control-handle identities | — | `N4 T1 P1 V1` | `-N4 -T1 -P1 -V1` |
| 10 | `stage_gateway_and_observer` | accepted contained cell/cgroup + stopped executable identities | `G1 T4 P4 V6` | — | `+G1 +T4 +P4 +V6` |
| 11 | `acquire_and_queue_control_credential` | broker/runtime + lease nonce + stopped control task/socket | `C1 S1 D1 U1 R1 V4` | `C1 S1 D1 U1 R1 V4` | `+C1 +S1` |
| 12 | `acquire_and_queue_preparation_credential` | broker/runtime + lease nonce + stopped database task/socket | `C1 S1 D1 U1 R1 V4` | `C1 S1 D1 U1 R1 V4` | `+C1 +S1` |
| 13 | `acquire_and_queue_observer_credential` | broker/runtime + lease nonce + stopped observer task/socket | `C1 S1 D1 U1 R1 V4` | `C1 S1 D1 U1 R1 V4` | `+C1 +S1` |
| 14 | `release_gateway_and_observer` | stopped tasks + queued receipts + duplex-channel, sealed-record, atomic-state and revocation identities | — | — | — |
| 15 | `provider_control_observe` | attestation lease + exact request digest | `L1 D1 U1 R1 V4` | `L1 D1 U1 R1 V4` | — |
| 16 | `observer_preflight` | attestation lease + query-corpus digest | `L1 D1 U1 R1 H1 O1 V4` | `L1 D1 U1 R1 H1 O1 V4` | — |
| 17 | `acquire_history_root` | history-parent descriptor identity + object nonce | `HR1` | — | `+HR1` |
| 18 | `create_history_cell` | phase parent-cgroup descriptor + cell nonce | `E1 CG1 N3` | — | `+E1 +CG1 +N3` |
| 19 | `launch_history_child` | accepted history-cell/cgroup identity | `T16 P16 OC2 V18` | — | `+T16 +P16 +OC2 +V18` |
| 20 | `history_gateway_roundtrip` | history phase lease + child start identity | `L1 D1 U1 R1 H1 V4` | `L1 D1 U1 R1 H1 V4` | — |
| 21 | `close_history_child` | accepted history task/pidfd identities | — | `T16 P16 OC2 V18` | `-T16 -P16 -OC2 -V18` |
| 22 | `close_history_cell` | accepted history cell/cgroup/namespace identities | — | `E1 CG1 N3` | `-E1 -CG1 -N3` |
| 23 | `verify_history` | accepted history-root identity + policy digest | `V1` | `V1` | — |
| 24 | `acquire_sealed_bundle` | bundle-root descriptor identity + WP-197 digest tuple | `BR1` | — | `+BR1` |
| 25 | `acquire_cli_root` | CLI-parent descriptor identity + object nonce | `CR1` | — | `+CR1` |
| 26 | `construct_and_verify_cli_workdir` | history/bundle/CLI descriptor identities | `V1` | `V1` | — |
| 27 | `create_dry_run_cell` | phase parent-cgroup descriptor + cell nonce | `E1 CG1 N3` | — | `+E1 +CG1 +N3` |
| 28 | `launch_dry_run_child` | accepted dry-run cell/cgroup identity | `T16 P16 OC2 V18` | — | `+T16 +P16 +OC2 +V18` |
| 29 | `dry_run_gateway_roundtrip` | dry-run phase lease + child start identity | `L1 D1 U1 R1 H1 V4` | `L1 D1 U1 R1 H1 V4` | — |
| 30 | `close_dry_run_child` | accepted dry-run task/pidfd identities | — | `T16 P16 OC2 V18` | `-T16 -P16 -OC2 -V18` |
| 31 | `close_dry_run_cell` | accepted dry-run cell/cgroup/namespace identities | — | `E1 CG1 N3` | `-E1 -CG1 -N3` |
| 32 | `observer_postflight` | attestation lease + preflight/query-corpus digests | `L1 D1 U1 R1 H1 O1 V4` | `L1 D1 U1 R1 H1 O1 V4` | — |
| 33 | `close_control_credential` | control recipient/queue + broker lease identity | — | `C1 S1` | `-C1 -S1` |
| 34 | `close_preparation_credential` | preparation recipient/queue + broker lease identity | — | `C1 S1` | `-C1 -S1` |
| 35 | `close_observer_credential` | observer recipient/queue + broker lease identity | — | `C1 S1` | `-C1 -S1` |
| 36 | `close_gateway_and_observer_tasks` | accepted gateway/observer process-set identity | — | `G1 T4 P4 V6` | `-G1 -T4 -P4 -V6` |
| 37 | `close_gateway_containment_and_egress` | accepted cell/cgroup/netns + sealed-egress identity | — | `E1 CG1 N3` | `-E1 -CG1 -N3` |
| 38 | `close_runtime_root` | accepted runtime-root descriptor identity | — | `RR1` | `-RR1` |
| 39 | `close_history_root` | accepted history-root descriptor identity | — | `HR1` | `-HR1` |
| 40 | `close_bundle_root` | accepted bundle-root descriptor identity | — | `BR1` | `-BR1` |
| 41 | `close_cli_root` | accepted CLI-root descriptor identity | — | `CR1` | `-CR1` |
| 42 | `close_external_window` | accepted window identity | — | `W1` | `-W1` |
| 43 | `close_target_quarantine` | accepted quarantine identity | — | `Q1` | `-Q1` |

The generated tape fixes every intent/accept/close record and mechanically expands every table cell
to the full vector; implementation may not insert, omit or reorder an adapter effect. Tests assert
every prefix is nonnegative and within caps and that the final sum is zero. Journal-only milestones
are separate fixed transitions.
Successful terminal live state is the all-zero 23-element vector. The retained super-lock inode,
registry chain and v2 journal inside the state root, plus the separately held root-owned sealed
bundle and broker's signed three-record terminal nonce-tombstone set, are outside the ephemeral
resource vector; the separately rooted proof-bootstrap registry/current-policy/manifest set is a
sixth approved retained class. All are named explicitly in closure evidence. `residueCount: 0`
means no unapproved artifact beyond those six retained classes; it never claims an empty filesystem
or places the bundle, tombstones or bootstrap records under the operation state root. The final observation is a
deterministic response view of the closed journal,
not another retained resource. A refused terminal also requires zero live/uncertain resources;
otherwise it remains recovery-only.

An effect is forbidden unless intent can name an immutable recovery anchor first. Processes are
anchored below an accepted cgroup; gateway operations use an operation/phase lease identity;
filesystem objects use held parent/object descriptors; provider reads bind request and response
identities. Names, paths, hostnames and PIDs without start identity are diagnostics only. A crash
after effect acceptance but before its accepted record either lets the persistent root custodian
commit the already-held identity or remains permanently recovery-only; it never retries or guesses.

## Fixed bounds and deadlines

The v2 journal permits at most 128 effects, 4,096 transitions, 12,288 records, 16,384 signatures,
16,384 bytes per canonical record and 64 MiB for the complete tree. CLI stdout and stderr are each
capped at the WP-197 value of 1,048,576 bytes. Observer output is at most 4,096 rows and 1,048,576
canonical bytes. Control HTTP permits at most 64 headers, 65,536 header bytes and 1,048,576 request
or response body bytes. PostgreSQL messages are at most 16,777,216 bytes, aggregate bytes in either
direction are at most 67,108,864, and a phase has at most 32 DNS answers and 32 connection attempts.
An overflow is recorded, permanently disqualifies success and still receives normal cleanup.

The WP-201 operation deadline is 3,600 seconds with an untouchable 180-second cleanup reserve.
Normal-work budgets are quarantine/attestation 120, credential acquisition 180 total, gateway
installation 120, observer preflight 120, history 600, bundle verification/workdir construction 300,
dry run 600, postflight 120 and journal/evidence 240 seconds. Work refuses to start if its declared
budget crosses the reserve. The separately authorized public-acquisition predecessor has its own
600-second bound and must be terminal with zero temporary resources before the WP-201 deadline or
operation begins; its time cannot consume or extend the WP-201 authorization window.
Cleanup reserves 15 seconds for output drain, 15 for TERM, 5 for KILL, 15 for reaping, 30 for
gateway/socket/lease closure, 60 for cgroup/session absence, 30 for watcher/root/descriptor
settlement and 10 for terminal publication. All waits share the same monotonic deadline. A boot-id
change disqualifies success; reconciliation receives a new cleanup-only deadline and cannot resume
normal work.
The authorization-derived monotonic deadline can only shorten the 3,420-second normal interval; it
cannot extend any budget or the external-window cleanup bound.

## Exact history, dry-run and observer evidence

History success requires exactly 41 files, 279,677 bytes, terminal version `20260901010000`, the
fixed baseline ledger digest and exact filename/version/size/digest order, with no missing, extra,
duplicate, linked, replaced, truncated or over-limit entry. The CLI workdir requires exactly 46
files, 646,628 migration bytes, terminal version `20260901060000` and exact WP-197 manifest and
ledger digests. Dry-run offered, parsed and matched counts each equal five; versions are exactly
`20260901020000` through `20260901060000` in order; bytes total 366,951; execution and mutation
counts are zero.

WP-197 construction is not reimplemented inside privileged Rust. Before the external operation, its
existing TypeScript builder produces and independently verifies a root-owned sealed 46-file bundle
under separate attended acquisition authority. The coordinator receives only its already-open root
descriptor. The runtime bridge independently validates all 46 entries, manifest, source revision,
counts, bytes, versions and digests, then compares every baseline byte to the fresh history fetch
and constructs the descriptor-owned CLI workdir. A TypeScript composition test runs the official
WP-197 verifier against the same synthetic artifact and requires exact agreement with Rust evidence.
No Node process or path is added to the privileged operation.

The observer accepts only its compiled query corpus. Each sample uses one fresh observer lease,
transaction, downstream/upstream socket and backend pid/start identity. It commits only after all
five are closed. Fixed statement/lock/idle deadlines stay within the phase budget. It captures
target identity, hosted prefix, queue, recommendation, schedule, privilege and every CLI/gateway/
observer login/PID/backend-start fingerprint independent of mutable application names. Changed,
empty, rejected and truncated tags observed at either sample count and refuse; transient tag changes
between samples are outside the claim and cannot evade the immutable census. Success requires byte-identical pre/post
evidence and zero remaining hosted sessions of every class. An instantaneous
probe is evidence, not an apply-race lock.

## Closed observation passed to WP-202

After postflight, the coordinator commits an immutable observation core containing only history,
bundle, dry-run, runtime, target, credential-scope, gateway/session and comparison digests. The core
contains no zero-resource, closed-state or closed-journal claim. It then closes every remaining
effect, independently inventories absence, commits conservation evidence, and syncs `closed`
referencing the core and conservation digests. It reopens and verifies the complete terminal journal
before deterministically serializing this final envelope:

```json
{
  "schemaVersion": "openspell.disposable-preparation-observation.v1",
  "purpose": "wp202_test_input_only",
  "operationBindingSha256": "...",
  "sourceRevision": "...",
  "proofBootstrapRegistrySha256": "...",
  "targetAttestationSha256": "...",
  "credentialScopeEvidenceSha256": "...",
  "brokerNonceTombstoneSetSha256": "...",
  "officialPreparationEvidenceSha256": "...",
  "gatewayAndEgressEvidenceSha256": "...",
  "historyEvidenceSha256": "...",
  "bundleEvidenceSha256": "...",
  "dryRunEvidenceSha256": "...",
  "prePostComparisonEvidenceSha256": "...",
  "observationCoreSha256": "...",
  "resourceConservationSha256": "...",
  "closedInventorySha256": "...",
  "closedJournalGeneration": 149,
  "closedJournalTransitionSha256": "...",
  "historyFileCount": 41,
  "dryRunItemCount": 5,
  "writeCapability": false,
  "writeEffectCount": 0,
  "taggedSessionCount": 0,
  "residueCount": 0,
  "authorityMutationGuardCount": 0,
  "authoritySigningKeyHandleCount": 0,
  "authorityReaderHandleCount": 0,
  "terminalState": "closed_no_apply"
}
```

There is no digest cycle: the journal binds the core and conservation; the envelope binds the
already committed terminal transition. A crash before `closed` remains recovery-only. A crash after
`closed` may derive only these deterministic bytes. Success and lost-response recovery both reopen
the terminal journal and reproduce the same envelope bytes and digest; no second effect or retained
observation file is created.

The external-effect conservation vector reaches zero before `closed`; authority-internal mutation
custody necessarily remains until that commit. `close_no_apply` then drops the signing key,
mutation descriptors and OFD guard. The read-only reopener exclusively holds the lock while proving
the state-root physical inventory is exactly super-lock/registry/v2-journal, the separate retained
bundle descriptor matches its journal-bound identity, the journal contains the exact broker-signed
terminal tombstone-set digest, and no authority key/mutation descriptor survives. It constructs the
immutable envelope, then closes its lock and descriptors before
returning, so
the three authority counts above are observed post-drop rather than predicted by the terminal
transition.

The successful generation is fixed at 149: 43 effects each contribute intent, accepted and closed
records (129), and the legal milestone path contributes 20 transitions through `closed`. A different
successful generation, an extra/missing effect or a `no_accept` record cannot serialize a success
envelope.

The envelope contains no bearer, raw reference/credential, endpoint, argv/environment, SQL/output,
path, PID/fd, approval/execution ticket, live lease, apply invocation, production window claim or
`safe`, `ready` or `authorized` label. WP-202 starts a fresh operation with fresh authorization,
nonce, target observation, quarantine, credentials, runtime measurement and apply-specific proof.

## Failure, timeout and privacy

Every adapter operation shares one absolute monotonic operation deadline with reserved time for
output drain, TERM, KILL, reaping, cgroup-empty proof, gateway closure, zero-session proof, observer
watcher and root settlement. Observer postflight is normal-path work with its separate 120-second
budget; it is never attempted after an uncertain effect. No nested timeout can extend the operation
deadline. Deadline or signal permanently
disqualifies success even if late output appears valid.

After an accepted, lost or unknown external effect, no new ticket or child may be issued. Recovery
uses only immutable identities and returns recovery-only until child, cgroup, gateway, upstream
socket and tagged-session terminality are exact. Cleanup cannot revoke/delete a provider credential
or delete a target: those are distinct external mutations with separate authorization.

Recovery applies these exact rules:

1. No durable intent means the effect did not begin.
2. Intent without `accepted` or `no_accept` is uncertain and is never retried.
3. Reconciliation may query only that intent's immutable recovery anchor.
4. For an acquisition/read effect, authoritative nonoccurrence permits `no_accept`; exact accepted
   identity permits `accepted` and cleanup. For a negative-delta release effect, authoritative
   terminal absence/closure of the exact prior identity permits `accepted` with that row's negative
   delta, while authoritative proof that it remains live and unchanged permits `no_accept` with
   zero delta. The 17 release kinds are single-resource or single-custody-set operations; none has
   a partially successful grouped delta.
5. Inability to establish the effect-kind-specific postcondition leaves the intent unclassified,
   stays recovery-only and grants no deletion authority.
6. An accepted identity may be adopted or closed only by exact identity; a closed effect is never
   closed again.
7. Partial, malformed, delayed or lost responses are lost even if success-shaped.
8. Signal, deadline, overflow, census loss or custodian death permanently disqualifies success.
9. No uncertain/open effect permits another ticket, new child, credential/network lease, start-trap
   release or observer call. Only the zero-acquisition recovery-cleanup lane may terminate a
   disjoint previously accepted child, gateway, credential or descriptor identity.
10. Only a reopened, verified terminal `closed` journal can reproduce the deterministic successful
    response without executing an effect.

An interruption before committed observer postflight cannot reach refused-terminal closure because
target no-change is unproved; after resource cleanup it remains recovery-only. A later observation
would require a new separately authorized reconciliation design and is not part of WP-201.

Raw target references, endpoints, credentials, provider bodies, database rows, CLI stdout/stderr,
paths, PIDs, nested errors and private topology stay private. Public output is one fixed refusal or a
bounded summary. Secret and target canaries must not occur anywhere in CLI-visible state, evidence,
logs, panic output or cleanup errors.

## Source-only versus external proof

### Step-3 root-container exactness amendment

This amendment closes the step-3 values that were intentionally left open. It is the implementation
contract for the source-only root proof; later code may not substitute a different image, endpoint,
network, label, mount, ledger, helper protocol or Cargo row without first amending and independently
reviewing this document and the brief again.

#### Problem, use and selected shape

The coordinator needs one executable root/procfs composition proof without becoming a reusable
Docker runner or a seed for the later external adapter. Turborepo may invoke only the coordinator's
fixed `scripts/test.mjs`. That script accepts no image, endpoint, path, network, command, feature,
timeout, environment map or credential. It owns one dependency-acquisition container and one fresh
root-proof container for each of the 28 frozen Cargo rows and unconditionally runs the package's
pure Vitest fault/boundary suite plus its closed real-Docker integration suite. No proof container
is reused, so root-executed build scripts or tests cannot carry
writable `/dev`, shared-memory, tmp, home, Cargo or target state into a later row. The Rust
coordinator remains a private `rlib` with no process or network API.

Three independent candidates agreed on this two-phase boundary. This contract selects the
strongest credential isolation and exact-ID custody design, the single union vendor tree, and the
bounded cleanup mechanics. It rejects separate vendor copies, a generic Docker abstraction,
Python as a ledger dependency, label/name-based deletion and any claim that a read-only host bind
is immutable against a hostile host peer.

#### Fixed identity, endpoint and image

The exact values are:

```text
invocation directory prefix: openspell-wp201-root-proof-
invocation value:            32 random bytes encoded as 64 lowercase hex
invocation record:           INVOCATION
invocation record bytes:     openspell.wp201.invocation.v1\n<invocation-value>\n
temporary parents, in order: /tmp, /var/tmp

Docker binary:               /usr/bin/docker
Docker binary metadata:      root:root, mode 0755, link count 1, 45570321 bytes
Docker binary SHA-256:       dbf7fd0c0ae54d208314ee5c19a97a12d966dab039b7d94872ca91cbe490373c
Docker client tuple:         Platform.Name="Docker Engine - Community", Version=29.7.2
                           ApiVersion=1.55, DefaultAPIVersion=1.55, GitCommit=a7dcaa6
                           GoVersion=go1.26.5, Os=linux, Arch=amd64
                           BuildTime="Wed Aug  5 18:28:40 2026", Context=default
Docker endpoint:             unix:///var/run/docker.sock
Engine API version:          v1.47
container platform:          linux/amd64

invocation label:            com.openspell.wp201.invocation
role label:                  com.openspell.wp201.role
acquisition role:            dependency-acquisition-v1
proof role:                  root-bridge-proof-v1
acquisition container name:  openspell-wp201-<invocation-value>-acquisition
proof container name:        openspell-wp201-<invocation-value>-proof-<row-id>

acquisition network:         bridge
proof network:               none

proof image:
docker.io/library/rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
```

`TMPDIR`, `TMP`, and `TEMP` are refused rather than consulted. Each parent must resolve to its literal
path, be a root-owned mode-`1777` directory outside the workspace, and have no symlink ancestry. The
wrapper tries them in the stated order and creates exactly
`<parent>/openspell-wp201-root-proof-<invocation-value>` with exclusive mode `0700`; it does not use
an additional random suffix. The mode-`0600`, link-count-one `INVOCATION` record is synced before
network or Docker access.

Before network access the wrapper stages only regular, stage-zero Git inputs from the three exact
package roots. `/usr/bin/git ls-files --stage -z -- <three fixed roots>` is the sole inventory
command. Accepted paths are each package's `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`,
regular `src/**/*.rs`, and exactly these four compile-time inputs:

```text
tools/hosted-migration-root-authority/src/grant-ticket-v1.golden.json
tools/hosted-migration-root-authority/src/preparation-policy-v1.golden.json
tools/hosted-migration-root-authority/src/transition-v1.golden.json
tools/hosted-migration-runtime-proof/fixtures/wp199-grant-ticket-v1.golden.json
```

Every accepted filesystem path must be tracked, and every tracked path must have index mode
`100644`. Anything untracked under `src` or `fixtures`, any other accepted-package file matching
an `include_bytes!` or `include_str!` literal, any other index mode, link, special file, duplicate,
non-UTF-8 path, nested mount or identity change across open/read closes the proof. The
wrapper copies those bytes with no-follow opens into `<invocation>/source` under the same
`tools/<package>` layout, then fixes proof-bound directories to `0555` and regular files to `0444`.
Index mode `100644` is an index assertion, not a live-workspace permission assertion. Ordinary
checkout modes including file mode `0664` and directory mode `0775` are accepted: the workspace is
never mounted, and only bytes that survive stable no-follow pathname/open/read identity checks and
match their fixed stage-zero Git object IDs are copied. Every component from the workspace root
through each fixed package root must itself be opened without following links and remain on the
workspace device and mount; a symlinked package root, a mount at or below the workspace, or a
replaced in-workspace ancestor refuses even when the resulting file bytes match. Mount boundaries
above the already selected workspace, such as the filesystem containing it, are recorded but are
not newly prohibited. The `0555`/`0444` requirements apply to the staged invocation snapshot, not
the checkout.
The enclosing invocation directory remains invoking-user-owned mode `0700`, so these immutable
read/execute bits do not expose the snapshot outside that private parent. Neither
container ever receives the workspace, `.git`, ignored files, `_local`, environment files,
1Password state, package scripts, `node_modules`, a socket, FIFO or device.

After construction settles, the invocation directory has exactly this relative tree and no other
entry:

```text
INVOCATION
source/<the complete frozen snapshot>
control/acquisition.sh
control/proof.sh
control/hostname
control/hosts
control/resolv.conf
docker/home/
docker/config/config.json
acquisition/vendor/<the complete normalized vendor tree>
acquisition/toolchain/<the complete normalized toolchain tree>
acquisition/vendor-ledger.v1
```

The invocation root and `acquisition` directory are invoking-user-owned mode `0700`.
`source`, every source directory, `control`, and every normalized vendor/toolchain directory are
mode `0555`; their regular files and all five control files are mode `0444`, except the ledger-bound
toolchain executables which are mode `0555`. `docker` and `docker/config` are mode `0500`,
`docker/config/config.json` is link-count-one mode `0400` with exact bytes `{}`, and the empty
`docker/home` is mode `0700`. `INVOCATION` is link-count-one mode `0600` with the bytes above, and
`acquisition/vendor-ledger.v1` is link-count-one mode `0444`. All entries are owned by the invoking
uid/gid, stay on the captured invocation filesystem, and have no nested mount. The transient
construction states are covered separately by the three-state cleanup protocol; no scratch,
archive, cache, FIFO or temporary ledger remains before `ledger-backed` is entered.

The configured image digest is an OCI index. Its exact selected runtime identity is the following
concatenation table; `+` means byte concatenation with no separator:

```text
index = "sha256:" + "0e2bcaef56d041a4" + "86784e54104a81ae" +
        "be0da44bd03019bd" + "70bc0401e42e4a97"
amd64 manifest = "sha256:" + "408fe88047cef61a" + "2087653b0c5255fa" +
                 "51c0f2d6d94ddedd" + "7a2562a9b91a46f6"
config = "sha256:" + "897e260d0a1a5a51" + "46433bdb73f62bd8" +
         "4f5f47e846d3485e" + "5f70f63912b5917d"
```

The selected manifest's five ordered compressed layer digests are:

```text
"sha256:" + "3af9207d37990175" + "f61d5ce9faa0c737" + "3ffcd2d6da1b6ba0" + "a9ca9d61f8f47cc9"
"sha256:" + "6b02178232c403d8" + "a6d5b460ad955dab" + "a177c38e178ed7dd" + "417e5c4d748e948d"
"sha256:" + "c5a4625b533197ab" + "b25ea2a32be06c59" + "c984d97c3c2dc995" + "2e0b76f2e81ee0d2"
"sha256:" + "d32ed818f20fae82" + "5717c40dbc77cd4e" + "d4bcefad6ba95a83" + "f8c4f3c1f8631c31"
"sha256:" + "a6c1a23a6280781f" + "0cf3b6b3a43fc594" + "62763953c4285dd4" + "addc7d4963cc923f"
```

Their exact descriptor sizes are `48497091`, `24044139`, `64408267`, `211659733` and `217852857`
in that order; the config descriptor size is `4547`. The manifest schema version is `2`, its media
type is `application/vnd.oci.image.manifest.v1+json`, the config media type is
`application/vnd.oci.image.config.v1+json`, and every layer media type is
`application/vnd.oci.image.layer.v1.tar+gzip`.

Docker 29.7.2's content-addressed `manifest inspect` response for that selected immutable manifest
also has one required top-level `annotations` map. The observed reformatted stdout is 1,846 bytes
with SHA-256 `973a2d5d3defa0ea0c186624870c0eb8ccbff0a1be0c9bf606d3cc9b3668ee56`;
that output digest records the reviewed observation but remains non-authoritative because JSON key
order and whitespace are not identity. The parser instead requires exactly these eight string
entries and no other annotation:

| key | exact value |
|---|---|
| `com.docker.official-images.bashbrew.arch` | `amd64` |
| `org.opencontainers.image.base.digest` | `sha256:f1695dea7f56437da0208aee8a6e473cec40a04864233ac5a344c5ee4b4f1d7e` |
| `org.opencontainers.image.base.name` | `buildpack-deps:bookworm` |
| `org.opencontainers.image.created` | `2026-08-10T22:41:20Z` |
| `org.opencontainers.image.revision` | `5ba8fc7544e1880d0fc5f56e9f11081082057dc2` |
| `org.opencontainers.image.source` | `https://github.com/rust-lang/docker-rust.git#5ba8fc7544e1880d0fc5f56e9f11081082057dc2:stable/bookworm` |
| `org.opencontainers.image.url` | `https://hub.docker.com/_/rust` |
| `org.opencontainers.image.version` | `1-bookworm` |

These manifest annotations are immutable descriptive identity attached to the already pinned
manifest, not execution authority. A missing, additional, non-string or changed entry refuses.

The selected image's five ordered uncompressed rootfs diff IDs are:

```text
"sha256:" + "63ecca237e30aca8" + "ae79232ae01dddab" + "7d8b42302f654f34" + "3f7cc7ddae60d57c"
"sha256:" + "e62aadfda549a23e" + "76f5bb43a9a5c652" + "f9e7312aba9edf5c" + "1411f7d0aed54eed"
"sha256:" + "3acdb7d9b7ebcd7f" + "62d99a996099a57b" + "8367821f4d9a3f4b" + "52239934425a7b98"
"sha256:" + "b33c96ad98497423" + "9102a1fe15e6427a" + "3510f13aa320227b" + "371c10bb40063356"
"sha256:" + "0bfd9a65e13cc272" + "6159178398201f52" + "cd4e5bd1c187584f" + "6953c839438af7d5"
```

Image pull, inspect and create all specify `--platform linux/amd64`. Client and server Engine API
versions must each be at least `1.49`. Platform-aware image inspection must return `Os=linux`,
`Architecture=amd64` and the ordered diff IDs above. Docker has two reviewed content-store
representations: its local `.Id` is either the selected manifest digest above (containerd store) or
the config digest above (classic graphdriver store). The wrapper accepts only those two full values
as `<local-inspect-ID>`; this inspection identity is never used as a create operand because the
containerd manifest ID is not independently addressable. When `.Descriptor` is present its digest,
media type, size `1940` and
platform must exactly equal the selected manifest values; an optional bounded string-only
annotations map is non-authoritative and ignored. No other descriptor field is accepted. When
`.Descriptor` is absent, `.Id` must be the config digest. Any other or mixed variant refuses. Every
create instead uses the exact immutable `<index-reference>` with `--platform linux/amd64 --pull
never`. Post-create inspection requires `.Config.Image` to equal that complete index reference. It
also binds the store representation: containerd's manifest-valued `<local-inspect-ID>` requires
container `.Image` to equal the index digest and `.ImageManifestDescriptor` to contain exactly the
selected manifest media type, digest, size `1940`, and platform `{architecture:"amd64",os:"linux"}`.
Its optional bounded string-only annotations map is non-authoritative. Classic's config-valued
`<local-inspect-ID>` requires container `.Image` to equal the config digest and
`.ImageManifestDescriptor` to be absent or null. Any other, cross-store or incomplete pairing
refuses start and success.

The image's `Config` object has exactly the keys `Env`, `Cmd` and `Labels`: no
`Entrypoint`, `User`, `WorkingDir` or `Volumes` key is present, so each has its OCI empty
default. `Cmd=["bash"]`; `Labels` contains only
`org.opencontainers.image.source=https://github.com/rust-lang/docker-rust`; and `Env` is exactly
these four entries in order:

```text
PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUSTUP_HOME=/usr/local/rustup
CARGO_HOME=/usr/local/cargo
RUST_VERSION=1.97.1
```

The content-addressed platform-manifest request must return exactly the config digest and ordered
compressed-layer descriptors above. The separately observed image descriptor, where the store
exposes it, supplies the selected manifest digest; the manifest command's reformatted JSON is not
misrepresented as raw digest evidence. The local runtime check binds the ordered expanded diff IDs
and effective config. `RepoDigests` is not compared to
the tag-bearing configured string. Instead, each entry is parsed, repository aliases are normalized
to `docker.io/library/rust`, and exactly one entry must have that repository plus the index digest.
Every create uses only `<index-reference>` plus `--platform linux/amd64 --pull never`.

The wrapper creates only the two deterministic, invocation-randomized container-name forms above;
they are recovery keys and are never deletion operands. It creates no images, tags, named volumes
or custom networks.
Every Docker CLI argument vector begins with `/usr/bin/docker --host
unix:///var/run/docker.sock --config <private-empty-config>`. The mode-`0500` config directory
contains only a mode-`0400` `config.json` with exact bytes `{}`. Docker children receive only a
private `HOME`, `PATH=/usr/bin:/bin`, `LANG=C` and `LC_ALL=C`; Engine API `v1.47` belongs only to the
socket helper. The wrapper refuses ambient `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS`,
`DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `DOCKER_CONFIG`, `DOCKER_API_VERSION`, proxy variables,
registry/auth variables, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`,
`NODE_TLS_REJECT_UNAUTHORIZED`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`, `SHELLOPTS`,
`CDPATH` and Git configuration variables. The already-running Node executable and invoking uid are
explicit trusted-computing-base inputs; no claim is made against code loaded before the refusal
checks.

The resolved Docker binary must equal the fixed path, metadata, SHA-256 and complete client tuple
above. The wrapper opens and hashes it before Docker access, retains its device/inode identity, and
revalidates path, type, owner, mode, link count, size, device and inode before and after every client
operation. The empty-config context must be `default` with the fixed endpoint, and the server API
must support platform inspection. Before and after every client operation the wrapper likewise
revalidates the anchored real path, socket type, root owner, exact mode `0660`, device and inode of
`/var/run/docker.sock`. The event helper opens that fixed socket literal itself.

The complete allowed Docker operation table is below. `P` means the common prefix above; every
argument position, template, stdout/stderr cap and parser is a source constant covered by boundary
tests. No other Docker verb is reachable.

| Operation | Exact suffix after `P` | Success output |
|---|---|---|
| context name | `context show` | exact `default\n`, 64-byte cap |
| context endpoint | `context inspect default --format {{json .Endpoints.docker.Host}}` | exact JSON string `"unix:///var/run/docker.sock"` plus LF, 4 KiB cap |
| API support | `version --format {{json .}}` | one bounded duplicate-key-free JSON object plus LF, 16 KiB cap; `Client` equals the frozen tuple and `Server.ApiVersion` parses to at least `1.49` |
| platform manifest | `manifest inspect <repository-at-manifest-digest>` | one duplicate-key-free JSON object plus LF with the exact schema/config/layer descriptors and eight-entry annotation map above, 1 MiB per stream |
| cached image | `image inspect --platform linux/amd64 <index-reference>` | one-element duplicate-key-free JSON array plus LF, 1 MiB per stream |
| image setup | `image pull --platform linux/amd64 <index-reference>` | exit zero, continuously drained 16 MiB per stream |
| label census | `container ls --all --no-trunc --filter <invocation-label> --format {{.ID}}` | zero or bounded full-ID-plus-LF rows, 1 MiB per stream |
| exact-name preflight/recovery | `container inspect <exact-container-name>` | one-element duplicate-key-free JSON array for recovery or the fixed exact-name not-found classification, 1 MiB per stream |
| create | exact role-specific arguments below | one full lowercase ID plus LF, empty stderr, 4 KiB per stream |
| inspect | `container inspect <owned-full-ID>` | one-element duplicate-key-free JSON array plus LF, 1 MiB per stream |
| acquisition start/attach | `container start --attach <owned-full-ID>` | exact acquisition marker plus one bounded USTAR stream on stdout, at most 768 MiB; continuously drained 16 MiB stderr |
| proof start/attach | `container start --attach --interactive <owned-full-ID>` | exact namespace-ready/gate protocol then bounded row output, 16 MiB per stream |
| remove | `container rm --force --volumes <owned-full-ID>` | exact full ID plus LF, empty stderr, 4 KiB per stream |
| absence | `container inspect <owned-full-ID>` | fixed not-found classification only; all other failures refuse |

`<repository-at-manifest-digest>` is exactly `docker.io/library/rust@` plus the selected amd64
manifest digest. The manifest operation is networked, credential-free acquisition evidence and is
run after a successful pull; the content-addressed response must match every execution-relevant
descriptor above. `<index-reference>` is the exact proof-image string above. Its sole accepted
cache-miss result is status `1`, stdout exactly `[]\n`, and stderr exactly `Error response from
daemon: No such image: rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97\n`;
only that classification authorizes the fixed image-pull operation. Container absence is status
`1`, stdout exactly `[]\n`, and stderr exactly `Error response from daemon: No such container:
<owned-full-ID>\n`. Exact-name absence is the same status and stdout with stderr exactly `Error
response from daemon: No such container: <exact-container-name>\n`. The frozen client bytes and
tuple are part of all three parsers' authority; status alone or localized/free-form stderr is never
accepted. `<invocation-label>` is the single token
`label=com.openspell.wp201.invocation=<invocation-value>`. The table statically excludes `run`,
`exec`, `cp`, `commit`, build operations, image removal,
container restart, network/volume mutation and label/name/list-derived deletion. Output overflow
latches cleanup, kills/reaps the client group and can never be success. The fixed create suffix is
the common security/resource sequence plus the role's exact mounts, entrypoint and command described
next; boundary tests compare the complete resulting argv rather than checking a subset.

There is no semantic-to-CLI translation left to implementation. After `P`, acquisition create is
exactly this ordered token vector. Angle-bracket fields are single tokens derived only from the
already validated invocation record, invocation-owned paths, invoking numeric uid/gid, the exact
index reference and the controller digest frozen below:

```text
container create
--platform linux/amd64 --pull never
--label com.openspell.wp201.invocation=<invocation-value>
--label com.openspell.wp201.role=dependency-acquisition-v1
--name openspell-wp201-<invocation-value>-acquisition
--read-only --cap-drop ALL
--security-opt no-new-privileges --security-opt seccomp=builtin
--security-opt apparmor=docker-default
--ipc private --cgroupns private --userns host --runtime runc
--restart no --init=false --log-driver none
--hostname wp201-acquisition --user <uid>:<gid> --network bridge
--pids-limit 128 --memory 2g --memory-swap 2g --cpus 2
--ulimit nofile=1024:1024 --shm-size 256m
--mount type=bind,src=<source>,dst=/input/source,readonly,bind-propagation=rprivate,bind-recursive=readonly
--mount type=bind,src=<acquisition-controller>,dst=/input/control.sh,readonly,bind-propagation=rprivate
--tmpfs /output:rw,nodev,nosuid,exec,size=1073741824,mode=0700,uid=<uid>,gid=<gid>
--tmpfs /tmp:rw,nodev,nosuid,noexec,size=1073741824,mode=0700,uid=<uid>,gid=<gid>
--tmpfs /wp201-home:rw,nodev,nosuid,noexec,size=16777216,mode=0700,uid=<uid>,gid=<gid>
--workdir /tmp --entrypoint /usr/bin/env
<index-reference>
-i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home TMPDIR=/tmp
RUSTUP_HOME=/usr/local/rustup RUSTUP_NO_UPDATE_CHECK=1 CARGO_TERM_COLOR=never LANG=C LC_ALL=C
/bin/bash --noprofile --norc -euo pipefail -c <acquisition-bootstrap>
wp201-acquisition-bootstrap
```

`<acquisition-bootstrap>` is one token containing the exact script
`test "$(/usr/bin/sha256sum /input/control.sh)" = "72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258  /input/control.sh"; exec /bin/bash --noprofile --norc -euo pipefail /input/control.sh`.
It contains no newline.

Each proof create is exactly the following ordered token vector. `<ledger-sha256>` is the full-file
SHA-256 of the already written and host-verified ledger; `<row-id>` is one member of the frozen
28-row list below. Neither is caller input.

```text
container create
--interactive
--platform linux/amd64 --pull never
--label com.openspell.wp201.invocation=<invocation-value>
--label com.openspell.wp201.role=root-bridge-proof-v1
--name openspell-wp201-<invocation-value>-proof-<row-id>
--read-only --cap-drop ALL
--security-opt no-new-privileges --security-opt seccomp=builtin
--security-opt apparmor=docker-default
--ipc private --cgroupns private --userns host --runtime runc
--restart no --init=false --log-driver none
--hostname wp201-proof --user 0:0 --network none
--pids-limit 512 --memory 6g --memory-swap 6g --cpus 4
--ulimit nofile=1024:1024 --ulimit nproc=512:512 --shm-size 2g
--mount type=bind,src=<source>,dst=/input/source,readonly,bind-propagation=rprivate,bind-recursive=readonly
--mount type=bind,src=<vendor>,dst=/input/vendor,readonly,bind-propagation=rprivate,bind-recursive=readonly
--mount type=bind,src=<toolchain>,dst=/input/toolchain,readonly,bind-propagation=rprivate,bind-recursive=readonly
--mount type=bind,src=<ledger>,dst=/input/vendor-ledger.v1,readonly,bind-propagation=rprivate
--mount type=bind,src=<proof-controller>,dst=/input/control.sh,readonly,bind-propagation=rprivate
--mount type=bind,src=<proof-hostname>,dst=/etc/hostname,readonly,bind-propagation=rprivate
--mount type=bind,src=<proof-hosts>,dst=/etc/hosts,readonly,bind-propagation=rprivate
--mount type=bind,src=<proof-resolver>,dst=/etc/resolv.conf,readonly,bind-propagation=rprivate
--tmpfs /cargo:rw,nodev,nosuid,noexec,size=268435456,mode=0700
--tmpfs /target:rw,nodev,nosuid,exec,size=4294967296,mode=0700
--tmpfs /tmp:rw,nodev,nosuid,noexec,size=1073741824,mode=0700
--tmpfs /fixtures:rw,nodev,nosuid,noexec,size=2147483648,mode=0700
--tmpfs /wp201-home:rw,nodev,nosuid,noexec,size=16777216,mode=0700
--workdir /tmp --entrypoint /usr/bin/env
<index-reference>
-i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/cargo CARGO_TARGET_DIR=/target/current TMPDIR=/fixtures
RUSTUP_HOME=/input/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu
RUSTUP_NO_UPDATE_CHECK=1 CARGO_NET_OFFLINE=true CARGO_TERM_COLOR=never LANG=C LC_ALL=C
/bin/bash --noprofile --norc -euo pipefail -c <proof-bootstrap>
wp201-proof-bootstrap <ledger-sha256> <row-id>
```

`<proof-bootstrap>` is one newline-free token containing exactly
`test "$(/usr/bin/sha256sum /input/control.sh)" = "914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb  /input/control.sh"; test "$(/usr/bin/sha256sum /input/vendor-ledger.v1)" = "$1  /input/vendor-ledger.v1"; exec /bin/bash --noprofile --norc -euo pipefail /input/control.sh "$2"`.
The image-resident Bash and SHA-256 utility therefore validate the independently pinned controller
and the host-bound complete ledger before controller execution. Complete argv fixtures expand every
field and reject omission, reordering, alternate flag spelling or an additional token.

#### Exact container layouts

Both creates specify `--platform linux/amd64`, `--read-only`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, `--security-opt seccomp=builtin`,
`--security-opt apparmor=docker-default`, `--ipc private`, `--cgroupns private`, `--userns host`,
`--runtime runc`, `--restart no`, `--init=false`, `--log-driver none`, the fixed hostname and resource
limits below. PID and UTS modes are left at Docker's private defaults and must inspect as empty;
privileged mode is false, `CapAdd`, supplementary groups, devices and device-cgroup rules are empty,
and restart count is zero. Docker 29.7.2's raw inspection JSON represents the unset nullable
`HostConfig.OomKillDisable` field as Boolean `false` while the container is created and as JSON
`null` after its successful exit. The parser binds that exact lifecycle-state-dependent
representation; the other Boolean/null variant, omission and every other value refuse. Any
unavailable or normalized-away setting refuses rather than relaxing.

| Setting | Acquisition | Root proof |
|---|---:|---:|
| user | invoking uid/gid | exact `0:0` |
| hostname | `wp201-acquisition` | `wp201-proof` |
| network | `bridge` | `none` |
| PIDs | 128 | 512 |
| memory and memory-swap | 2 GiB each | 6 GiB each |
| CPUs | 2 | 4 |
| `nofile` soft/hard | 1,024/1,024 | 1,024/1,024 |
| `nproc` soft/hard | not set; the PIDs cgroup is the bound because host-user accounting is shared | 512/512 |
| `/dev/shm` | 256 MiB | 2 GiB |

Every bind uses `bind-propagation=rprivate`; directory input binds additionally require
`bind-recursive=readonly`. Before create, `/proc/self/mountinfo` must prove no mountpoint at or below
any input/output source other than its containing system filesystem. The acquisition container has
exactly these configured mounts:

| Host/source | Destination | Access |
|---|---|---|
| `<invocation>/source` | `/input/source` | recursive read-only bind |
| `<invocation>/control/acquisition.sh` | `/input/control.sh` | read-only file bind |
| private tmpfs | `/output` | read-write, nodev, nosuid, exec, mode `0700`, invoking uid/gid, 1 GiB |
| private tmpfs | `/tmp` | read-write, nodev, nosuid, noexec, mode `0700`, invoking uid/gid |
| private tmpfs | `/wp201-home` | read-write, nodev, nosuid, noexec, mode `0700`, invoking uid/gid |

The networked acquisition container also has Docker's private `/proc`, `/dev`, `/dev/pts`,
`/dev/mqueue`, `/dev/shm`, `/sys`, cgroup and generated `/etc/hostname`, `/etc/hosts` and
`/etc/resolv.conf` mounts. Those three `/etc` binds are daemon-owned and writable inside this
unprivileged setup container only; they are never evidence and disappear with exact-ID removal.
Inspection must show no other configured bind, tmpfs, volume or device.
`/output` is executable only because the frozen Rustup proxy must invoke the independently pinned
copied toolchain while components are acquired; no crate source, build script, proc macro or test is
executed in this phase. Its hard 1 GiB tmpfs and the exact archive decoder below bound all bytes that
can reach the host. Docker volumes and writable host binds remain absent.

The root proof has exactly these configured mounts:

| Host/source | Destination | Access |
|---|---|---|
| `<invocation>/source` | `/input/source` | recursive read-only bind |
| `<invocation>/acquisition/vendor` | `/input/vendor` | recursive read-only bind |
| `<invocation>/acquisition/toolchain` | `/input/toolchain` | recursive read-only bind |
| `<invocation>/acquisition/vendor-ledger.v1` | `/input/vendor-ledger.v1` | read-only file bind |
| `<invocation>/control/proof.sh` | `/input/control.sh` | read-only file bind |
| fixed mode-`0444` proof hostname | `/etc/hostname` | read-only file bind |
| fixed mode-`0444` loopback hosts | `/etc/hosts` | read-only file bind |
| fixed empty mode-`0444` resolver | `/etc/resolv.conf` | read-only file bind |
| private tmpfs | `/cargo` | read-write, nodev, nosuid, noexec, mode `0700`, 256 MiB |
| private tmpfs | `/target` | read-write, nodev, nosuid, exec, mode `0700`, 4 GiB |
| private tmpfs | `/tmp` | read-write, nodev, nosuid, noexec, mode `0700`, 1 GiB |
| private tmpfs | `/fixtures` | read-write, nodev, nosuid, noexec, mode `0700`, 2 GiB |
| private tmpfs | `/wp201-home` | read-write, nodev, nosuid, noexec, mode `0700`, 16 MiB |
| Docker-private shared-memory tmpfs | `/dev/shm` | read-write, nodev, nosuid, noexec, mode `1777`, 2 GiB |

The proof's fixed `/etc/hostname` bytes are `wp201-proof\n`; `/etc/hosts` bytes are exactly
`127.0.0.1 localhost\n::1 localhost\n`; `/etc/resolv.conf` is zero bytes. Its complete accepted writable-mount
destinations are:

```text
/cargo /target /tmp /fixtures /wp201-home
/dev /dev/pts /dev/mqueue /dev/shm
/proc /proc/interrupts /proc/kcore /proc/keys /proc/latency_stats /proc/timer_list
```

The first row is the explicit tmpfs set. The remaining paths are Docker/kernel-private pseudo
filesystems; none is a writable host bind or survives container deletion. The controller parses its
own duplicate-free `/proc/self/mountinfo`, requires that exact writable set, and also requires
read-only sysfs and cgroup2 plus the architecture's exact procfs topology, including the distinct
read-only `/proc/sys` mount. Any additional writable mount refuses before source execution.
Namespace inode comparisons require private mount, PID, IPC, UTS, network and cgroup namespaces;
the explicitly selected host user namespace is the sole same-namespace exception.

Proof-container inspection additionally requires `AttachStdin=true`, `OpenStdin=true`,
`StdinOnce=true`, `AttachStdout=true`, `AttachStderr=true` and `Tty=false`; all three stdin fields are
false for acquisition. Immediately before proof start, the wrapper reads its own fixed procfs
namespace links for `cgroup`, `ipc`, `mnt`, `net`, `pid`, `user` and `uts`. The proof controller
first validates the empty private mounts and complete mount table, then proves its namespace links
equal PID 1's links, and emits exactly
`openspell.wp201.namespace-ready.v1\n`. Only after receiving that first complete stdout line may the
wrapper write this exact LF-terminated frame to the attached stdin and then close it:

```text
openspell.wp201.namespace-gate.v1
cgroup:[<host-decimal-inode>]
ipc:[<host-decimal-inode>]
mnt:[<host-decimal-inode>]
net:[<host-decimal-inode>]
pid:[<host-decimal-inode>]
user:[<host-decimal-inode>]
uts:[<host-decimal-inode>]
```

The controller accepts EOF immediately after the last LF, requires its user namespace to equal the
host value and all other listed namespaces to differ, then re-reads every saved proof namespace
identity after Cargo and requires it unchanged. A missing, reordered, duplicated, malformed or
trailing byte, a readiness marker emitted before the mount/namespace checks, or Cargo progress
before readiness refuses the row.

The controller performs byte-preserving validation rather than parsing directly into Bash
variables: it reads at most 513 stdin bytes into a link-count-one mode-`0600` root-owned file on the
fresh `/fixtures` tmpfs, requires a size no greater than 512, rejects any `00` byte in the complete
hex inventory, requires the last byte to be LF and exactly eight LF-terminated lines, and only then
loads the lines and applies the fixed labels plus one-to-20-digit inode grammar. It deletes the
frame before Cargo. An embedded NUL, an unterminated trailing fragment, a 513th byte or a ninth line
therefore cannot be lost by Bash `read` semantics.

Both containers have working directory `/tmp`, entrypoint `/usr/bin/env`, the frozen base
`Config.Env` only, and command `-i` followed by the exact environment assignments, `/bin/bash`,
`--noprofile`, `--norc`, `-euo`, `pipefail`, and `/input/control.sh`. The acquisition assignments are
`HOME=/wp201-home`, `CARGO_HOME=/output/cargo-home`, `TMPDIR=/tmp`,
`RUSTUP_HOME=/usr/local/rustup`, `RUSTUP_NO_UPDATE_CHECK=1`, `CARGO_TERM_COLOR=never`, `LANG=C` and
`LC_ALL=C`. Both acquisition and proof Cargo/Rustup children include the exact
`PATH=/usr/local/cargo/bin:/usr/bin:/bin`, which is required for Cargo to invoke the pinned Rust
tools and the base-image linker. The remaining proof assignments are exactly
`HOME=/wp201-home`, `CARGO_HOME=/cargo`,
`CARGO_TARGET_DIR=/target/current`, `TMPDIR=/fixtures`, `RUSTUP_HOME=/input/toolchain`,
`RUSTUP_TOOLCHAIN=` plus `1.97.1-` + `x86_64-unknown-linux-gnu`, `RUSTUP_NO_UPDATE_CHECK=1`,
`CARGO_NET_OFFLINE=true`, `CARGO_TERM_COLOR=never`, `LANG=C` and `LC_ALL=C` in that order. Every
Cargo/rustup child is itself launched through `/usr/bin/env -i` with
only its exact row variables, so Bash-maintained `PWD`, `SHLVL` and `_` are not inherited. The proof
receives neither the Docker socket nor a writable host bind.

#### Exact dependency acquisition and vendor ledger

The pinned base image contains only Cargo, Rustc and the standard library; it does not contain
Rustfmt or Clippy. Acquisition therefore runs these fixed setup operations once, in order, and no
repository compiler, build script, proc macro, test or proof:

Before its first output creation or network-capable command, the acquisition controller requires
these nine dependency-authority inputs to be link-count-one mode-`0444` regular files with exact
size and SHA-256:

| Relative path | Bytes | SHA-256 |
|---|---:|---|
| `tools/hosted-migration-preparation-proof/Cargo.toml` | 558 | `5c89e16cac4721f4a968b2089efcea8fb9c1fe98225d6979166e2c2a3461bad9` |
| `tools/hosted-migration-preparation-proof/Cargo.lock` | 15,208 | `f3455774926880919588246bc9fc422e3ece13c29250862b4249b91b55ecbc86` |
| `tools/hosted-migration-preparation-proof/rust-toolchain.toml` | 86 | `8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e` |
| `tools/hosted-migration-root-authority/Cargo.toml` | 787 | `7639e2f59bb0c745b54a192478d86bba1ab1a046066ea490efa6b783e4e2860a` |
| `tools/hosted-migration-root-authority/Cargo.lock` | 13,741 | `bd460b4ca9b06241a393eb9d4b5bcc05b68a6d6af844fab1f9a683826979f6f5` |
| `tools/hosted-migration-root-authority/rust-toolchain.toml` | 86 | `8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e` |
| `tools/hosted-migration-runtime-proof/Cargo.toml` | 1,047 | `cfca33ad8a621f30fd54c4a9843eb1dd2add8a91cb4d785c60cabd4ccb945364` |
| `tools/hosted-migration-runtime-proof/Cargo.lock` | 15,493 | `58e3c00b558af03db96516e7e62f5df170630a28a9c29395b1e1de477a82f6aa` |
| `tools/hosted-migration-runtime-proof/rust-toolchain.toml` | 86 | `8e390d6a0838315f972690f46ef8bae8b7ecc9ee6c1ed70140ef852869c2482e` |

```text
/bin/mkdir -p /output/toolchain /output/rustup-cargo /output/cargo-home
/bin/cp -R /usr/local/rustup/. /output/toolchain/
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/rustup-cargo \
  RUSTUP_HOME=/output/toolchain RUSTUP_NO_UPDATE_CHECK=1 LANG=C LC_ALL=C \
  /usr/local/cargo/bin/rustup component add \
  --toolchain 1.97.1-x86_64-unknown-linux-gnu rustfmt clippy
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo fetch \
  --manifest-path /input/source/tools/hosted-migration-runtime-proof/Cargo.toml --locked
/usr/bin/env -i PATH=/usr/local/cargo/bin:/usr/bin:/bin HOME=/wp201-home CARGO_HOME=/output/cargo-home \
  RUSTUP_HOME=/output/toolchain RUSTUP_TOOLCHAIN=1.97.1-x86_64-unknown-linux-gnu \
  CARGO_TERM_COLOR=never LANG=C LC_ALL=C /usr/local/cargo/bin/cargo vendor \
  --manifest-path /input/source/tools/hosted-migration-preparation-proof/Cargo.toml \
  --sync /input/source/tools/hosted-migration-root-authority/Cargo.toml \
  --sync /input/source/tools/hosted-migration-runtime-proof/Cargo.toml \
  --locked --versioned-dirs /output/vendor
```

The generated controller contains those complete literal argument vectors and no eval,
interpolation or generic runner. It caps and deletes Cargo's vendor instruction output, deletes
`cargo-home` and `rustup-cargo` inside `/output`, requires the only remaining top-level names to be
`toolchain` and `vendor`, validates their exact counts/bytes/ownership/types, normalizes directories
to `0555`, vendor files to `0444`, and toolchain files to `0444` or `0555` according to their
pre-normalization execute bits, then revalidates the final toolchain authority digest.

The container then writes exactly `openspell.wp201.acquisition-archive.v1\n` followed by a GNU tar
1.34 USTAR stream created with the source-constant vector `--create --file=- --format=ustar
--blocking-factor=1 --sort=name --numeric-owner --owner=0 --group=0 --mtime=@0
--directory=/output toolchain vendor`. The archive is exactly 724,207,616 bytes after the 39-byte
marker and contains only normalized regular-file and directory entries. The host's narrow streaming
decoder accepts only checksum-valid USTAR headers, type `0` regular files or type `5` directories,
zero uid/gid/mtime, empty link/device fields, exact normalized modes, unique grammar-valid paths
under those two roots, the frozen entry counts and byte totals, two terminal zero blocks and EOF.
It rejects extension/PAX/GNU/long-name/sparse/link entries and writes through exclusive no-follow
opens beneath the pre-opened empty mode-`0700` acquisition directory. It never invokes host tar,
never buffers the archive as a pathname, caps the stream at its exact size, and normalizes and
revalidates the extracted tree independently before ledger creation. Thus both container storage
and bytes written to the host are bounded even though Docker cannot copy data from a stopped tmpfs.
The acquisition container may exit only after the complete archive is emitted; its `/output`,
`/tmp` and `/wp201-home` then disappear with exact-ID removal.

USTAR pathname decoding is canonical rather than normalizing aliases. The decoder first obtains the
raw archive name as `name` when `prefix` is empty, otherwise exactly `prefix + "/" + name`; both
fields must have canonical NUL padding and the split must equal GNU tar's rule: use an empty prefix
when the complete raw name is at most 100 bytes, otherwise split at the rightmost nonterminal slash
that leaves a nonempty name of at most 100 bytes and a prefix of at most 155 bytes. A type-`5` raw
name must end in exactly one `/`, a type-`0` name must not end in `/`, and the decoder removes only
that one required directory terminator before applying the logical path grammar. Duplicate logical
paths, a file/directory type conflict, a file used as an ancestor, a missing directory ancestor, a
leading/doubled slash, or an empty, `.` or `..` logical component refuses before any conflicting
write. Header magic/version, octal number encodings, checksum spacing, empty uname/gname/linkname,
zero device fields and all unused/padding bytes must equal the one GNU tar 1.34 USTAR encoding; a
semantically equivalent alternate header is not accepted.

The exact LF-terminated acquisition controller is the 9,956-byte reviewed fixture
`docs/design/wp201-controller-fixtures/acquisition-controller.sh`, with SHA-256
`72290e827399c5e6eb4c597312a65fbd6402c2d8ad87993c7e336a27f6d48258`; the exact LF-terminated proof
controller is the 30,322-byte reviewed fixture
`docs/design/wp201-controller-fixtures/proof-controller.sh`, with SHA-256
`914feaa7cece86e66a81a4dd8595d7efc2ae2e7be241d6190aee97c5c213bfcb`. Both are also immutable
source constants in `scripts/test.mjs`; it writes them without transformation to link-count-one
mode-`0444` files before network access. Boundary fixtures byte-compare the source constants to
these reviewed preimages, byte lengths and hashes,
and the image-resident bootstrap checks each hash before controller execution. A controller-byte
change therefore requires an architecture amendment and cannot be blessed only by changing a test.

The three lockfiles are independent inputs. Their frozen package/registry/checksum counts are
respectively `68/65/65`, `61/60/60` and `69/68/68` for coordinator, root authority and runtime
proof. The coordinator lock correction is exactly the addition of its already-declared
root-authority `zeroize` dependency edge and changes none of those counts. Every non-path source
must be the checksummed crates.io registry; Git sources, alternate registries, source replacement,
patch, credential provider and unchecksummed packages refuse.

The reviewed union vendor contains 3,657 regular files, 941 directories and 67,159,121 regular-file
bytes. The reviewed source snapshot has 45 regular files, 10 directories and 1,283,730 regular-file
bytes. Its 55-row source ledger is 6,533 bytes with SHA-256
`a8020e58a2ef55706e89498dd87cf4186f9e83e4c673f8273aaf96591b75a5a6`. The reviewed
Rustfmt/Clippy toolchain contains 168 regular files, 28 directories and 653,573,520 regular-file
bytes. All have zero links and no path outside the grammar below. With four control files, the full
ledger has exactly 4,853 records. A future count difference is a review-requiring input change, not
an accepted platform variation.

Root execution does not authorize whichever toolchain happened to arrive. Before component
acquisition, the exact base-image Rustup tree must produce this separate canonical authority-ledger
tuple: 156 files, 26 directories, 620,842,587 regular-file bytes, 182 records, 28,579 ledger bytes,
body hash `5a353a8d1309676d09d5c12af80150c617455ea7bac22086acb3f7c0391f1c48`, and full-ledger SHA-256
`a77010df3812df474f968ff3b7e85ec0f23d6e819f4f6d7ea5b95b276efdc8a6`. The copied tree must match
that tuple before Rustup runs. After adding exactly Rustfmt and Clippy, it must produce: 168 files,
28 directories, 653,573,520 bytes, 196 records, 30,553 ledger bytes, body hash
`1dcabbf3617ff9821771b09f430a636af81077b643bf32385aadd3c0b9fc1274`, and full-ledger SHA-256
`6078f49e711c3a7059e11a8a7b37f5f49837c792523bd914e0592b42d8f087a4`. Two independent clean
acquisitions produced the same final tuple. This simultaneously proves every base Cargo/Rustc/
Rustup byte remained exact outside the reviewed component delta.

The authority ledger has magic `openspell.wp201.toolchain-authority.v1`, then the same `records`,
`D`, `T` and `end` grammar below. It contains only the `D` rows whose path is `toolchain` or begins
`toolchain/` and all `T` rows. Acquisition constructs and validates the base and final versions;
the host and every proof container independently reconstruct and require the final fixed digest.
The reviewed Rust distribution manifest digest is
`03569b1886ceb5c05276b50c8431ab111de944cd6140fe1fa7d821dd8e0f29cf`; its x86-64 Linux Clippy
gzip/xz archive digests are `66f93a616bc84939e116e960599b3bc122be7b51f6562bad71011a64a9293dc3` /
`3441df8fb54db985f8c8a3e8356b8874a3f92cc8cca8565cfe36f1dc15935e72`, and Rustfmt gzip/xz
digests are `810f7dcfe64bdaf3e10cbe942274f76cdab2ffca813bfafc75e9d86a6809f039` /
`907fe97d6afbde1eca1b34c992c76e1406d422e2e6f137813d382acec7eb4d14`.

The mode-`0444` ledger has this exact LF-terminated UTF-8 grammar and EOF immediately after the end
row's LF:

```text
openspell.wp201.vendor-ledger.v1
records<TAB><shortest-unsigned-decimal>
D<TAB>0555<TAB><logical-directory-path>
...
S<TAB>0444<TAB><size><TAB><64-lowercase-hex-sha256><TAB><source-relative-path>
...
V<TAB>0444<TAB><size><TAB><64-lowercase-hex-sha256><TAB><vendor-relative-path>
...
T<TAB><0444-or-0555><TAB><size><TAB><64-lowercase-hex-sha256><TAB><toolchain-relative-path>
...
C<TAB>0444<TAB><size><TAB><64-lowercase-hex-sha256><TAB><fixed-control-path>
...
end<TAB><64-lowercase-hex-sha256-of-every-byte-before-the-end-row>
```

`records` counts every `D`, `S`, `V`, `T` and `C` row. `D` paths have an exact tree discriminator:
the root rows are `source`, `vendor` and `toolchain`, and every descendant is that root plus `/` plus
its relative path. All three roots, every descendant directory and every empty directory receive a
row. `S` paths begin `tools/` and are relative to the source snapshot root; they cover every staged
Cargo manifest, all three raw lockfiles, three toolchain declarations, every staged Rust source/test
file and the four exact JSON inputs above. `V` paths are relative to `vendor` and cover every regular
file, including each `.cargo-checksum.json`. `T` paths are relative to `toolchain` and cover its
complete acquired contents. `C` path is exactly one of `control/proof.sh`, `etc/hostname`,
`etc/hosts` or `etc/resolv.conf`, mapped respectively to the four individual proof file binds. Rows
sort by unsigned bytes of `tag || TAB || path`; duplicates refuse. The host writer and image-resident
verifier use exactly these same logical-to-mounted-path mappings.
Paths are relative UTF-8 of at most 1,024 bytes matching `[A-Za-z0-9._+@/-]+`, with no empty,
absolute, repeated-slash, `.` or `..` component. Decimal fields have no sign or leading zero except
`0`. CR, NUL, blank lines, extra fields, trailing spaces or trailing bytes refuse. Bounds are
131,072 records, 16 MiB ledger bytes, 256 MiB per regular file and 2 GiB total regular-file bytes.
The directory set must equal all observed directories, not merely the parents derivable from files.

Before normalization, every entry produced by dependency acquisition must belong to the invoking
uid/gid and stay on the invocation filesystem. A directory must have owner `rwx`, no special bit
and no group/other write; a regular file must have owner `rw`, link count one, no special bit and no
group/other write. These acquisition-output predicates do not apply to the live source checkout,
whose separate authenticated-copy rules are fixed above. Links, special files, nested mounts and
any other acquisition-output mode refuse. Proof-bound directories normalize to
`0555`; source, vendor and control files normalize to `0444`. A toolchain regular file normalizes
to `0555` iff its accepted pre-normalization mode had any execute bit, otherwise `0444`; the resulting mode is in its
`T` row. Every Cargo checksum map must have exact membership and matching contents.

A host-side implementation writes the mode-`0444`, link-count-one ledger. Before and after the one
Cargo process in every fresh proof container, a separate fixed POSIX-shell/coreutils implementation from the pinned image
enumerates directories and regular files, regenerates the complete ledger into `/fixtures` and
byte-compares it. The verifier also checks the three lock inventories, exact path-package set,
toolchain component list and executable modes. No Python, Node, compiled repository source or
fetched executable participates in that independent check.
Before any Cargo process it also proves that the complete success-marker byte string is absent from
the acquisition controller, proof controller, vendor and toolchain. It is expected only in the
staged root-authority test source that emits it.

#### Exact event-helper protocol and create custody

Every host-side production child is launched only through
`scripts/child-containment.mjs` and the fixed
`scripts/child-containment-launcher.mjs`. The parent creates one exclusive 256-bit-named child
cgroup below its exact delegated cgroup and retains descriptor capabilities for the child and
parent cgroups. The launcher is a persistent process-group leader. It moves itself into the child
cgroup through its inherited `cgroup.procs` capability and emits a nonce-bound adoption frame
before it reads the one-use release pipe. The parent independently requires that the child cgroup
is populated by exactly that live launcher PID before release; consequently the payload cannot run
before containment or, for the cut harness, before the fd-7 handoff settles. Only the declared
payload descriptors cross the second spawn. Cgroup capabilities and the private release, signal,
status and parent-lifetime channels never reach the payload.

Graceful `SIGINT`/`SIGTERM` is an exact private command to the still-live guardian, which signals
its pinned process group. Forced settlement writes only to the retained `cgroup.kill` capability;
there is no parent-side numeric PID or process-group signal fallback. The guardian reports the
payload PID and terminal result on bounded nonce-bound frames, evacuates itself through the exact
parent `cgroup.procs` capability, requires `populated 0`, removes empty nested cgroups deepest-first
and removes the exact child cgroup before terminating. It deliberately terminates itself with
`SIGKILL` after reporting the payload result, so callers use the authenticated result frame rather
than mistaking the guardian's terminal signal for the payload's. Parent-control EOF before release
or while a payload is live triggers the same evacuation, recursive kill, empty proof and exact
removal path. Parent settlement independently requires payload streams at EOF, release and status
channels settled, child-cgroup emptiness or authenticated pathname absence, exact pathname absence,
closed retained descriptors with `EBADF`, and no matching child-cgroup directory descriptor.

`src/containment.test.ts` statically proves that the fixed guardian is the only production source
that calls raw `spawn`. Its real cgroup tests prove pre-release payload unreachability, recursive
removal of same-group and detached descendants without touching an unrelated process, and guardian
cleanup after parent death. This boundary trusts the fixed launcher and same-uid parent as stated
below; it is containment for trusted proof programs, not a hostile same-uid sandbox.

`scripts/docker-event-helper.mjs` has no caller-selected argument. The wrapper launches it with the
already-running process's captured `process.execPath`, the fixed resolved script path, and no later
argument, in an owned guardian cgroup with an environment containing only `LANG=C` and `LC_ALL=C`.
Its descriptor table is:

| Descriptor | Direction | Contract |
|---:|---|---|
| `0` | none | `/dev/null` |
| `1` | none | `/dev/null` |
| `2` | helper to parent | private diagnostic pipe capped at 4,096 bytes |
| `3` | parent to helper | exact OPEN then CLOSE control frames |
| `4` | helper to parent | exact ready frame, then EOF |
| `5` | helper to parent | zero or one exact event-ID frame, then EOF |

Control opens with exact ASCII bytes
`openspell.wp201.docker-event-open.v2\n<invocation-value>\n<role>\n<exact-container-name>\n`.
The helper validates before socket connection that the name is exactly the acquisition name for the
acquisition role or the exact proof name for one member of the frozen 28-row set. All 29 possible
OPEN frames are unique and no more than 256 bytes. The parent writes exactly
`openspell.wp201.docker-event-close.v1\n` only after every identity known before the preliminary
census has been removed and proved absent and that census has been classified under the fixed
deferred-event rule below. On receiving the complete CLOSE frame, the helper parses and emits any complete
matching event frame already decoded before that control-frame linearization point, closes its
Engine socket, closes the event and ready pipes and settles; it does not emit an event after event
pipe EOF. Arbitrary pipe chunking is
accepted, but an incomplete frame at EOF, duplicate, trailing or out-of-order frame, unknown role,
or EOF before CLOSE refuses. The ready frame is exactly
`openspell.wp201.docker-event-ready.v1\n`. It is emitted only after the helper connected to the
revalidated fixed Unix socket, wrote and flushed every byte of the complete HTTP request, and parsed
a complete valid HTTP 200 response header block. The reviewed daemon emits those headers before any
matching event; if it does not, the readiness deadline refuses before create. The event frame is exactly
the byte concatenation `openspell.wp201.docker-event-id.v1\n` +
`<64-lowercase-hex-ID>\n`. The helper exits zero only after CLOSE, socket closure, all output EOFs
and internal settlement; the parent must reap it inside the existing ten-second watcher allocation.

The helper sends one fixed HTTP request to `/v1.47/events?since=0&filters=<encoded-filter>`.
The literal `since=0` requests the daemon's retained global backlog from the Unix epoch before
continuing as a live stream. It narrows the request-flush/subscriber-registration race, but is not
claimed lossless: the pinned daemon flushes `200` before subscription and retains only 256 global
events, so unrelated churn can evict a matching create. Exact-name recovery below closes cleanup
custody for that case without turning a missing event into proof success. Canonical filter JSON is
`{"container":["<exact-container-name>"],"event":["create"],"label":["com.openspell.wp201.invocation=<value>"],"type":["container"]}`.
It is compactly encoded and canonically percent-encoded in the request target; the longest request
is 425 bytes. Docker combines distinct filter keys, while multiple values for one key are OR, so
there is exactly one invocation-label value and the exact name is a separate `container` key. The
daemon's container matcher accepts exact values or prefixes, making this filter a narrowing aid and
never custody. The helper independently requires the decoded event's exact invocation label, role
label and `Actor.Attributes.name`; an event carrying the invocation label with a missing/wrong role
or non-exact name is a collision and refuses. Existing duplicate-key
rejection and raw `timeNano` rules remain mandatory. Headers cap at 8,192 bytes, each decoded HTTP
chunk/event frame at 65,536 bytes, and the complete stream before CLOSE at 1 MiB. Redirect, upgrade,
content encoding, ambiguous content-length/transfer-encoding, a non-200 response once bytes arrive,
EOF before CLOSE, trailing bytes in a
JSON frame, or a second exact-target event refuse. A syntactically valid frame with a different
invocation value is ignored but counts toward the cumulative cap; a matching-invocation frame with
a missing or wrong role or non-exact `Actor.Attributes.name` is a collision and refuses. Such
nonmatching frames cannot arrive from a compliant daemon after the server-side filter, but fixtures
place them before and after the matching event to prove they cannot be adopted by the decoder path.

Before starting the watcher, the parent requires the exact generated container name to have the
frozen exact-name absence result. It then receives the daemon-acknowledged ready frame before
create. Parsed HTTP 200 headers prove daemon receipt, while the fixed `since=0` replay cursor reduces
the local-flush/subscriber-registration race. Normal proof success still requires the matching
event. Exact stdout framing `<64-lowercase-hex-ID>\n` from this one create client establishes
immutable cleanup custody after the client is reaped even if it later exits nonzero, emits bounded
stderr or must be killed. Exit zero, empty stderr and equality with the event remain start/success
gates. The event ID independently establishes cleanup custody. A response/event conflict refuses
success and cleanup removes and absence-checks the unique union of both channel-bound IDs. A second
event is cleanup-uncertain. Neither channel yielding an ID after create may have been issued is the
pre-recovery unresolved state. A present result from the one exact-name recovery below may add valid
cleanup custody; an absent, ambiguous, hung or identity-invalid recovery cannot close the already-
issued mutation and is terminally cleanup-uncertain. Label
inventories are bounded diagnostics only and never confer identity or deletion authority.

Configuration validity is a separate, stricter gate. An owned ID is inspected for image, labels,
argv, uid, network, mounts, namespace/security/resource settings, environment and pre-start state.
A mismatch refuses start and success but still removes and absence-checks that response/event-owned
full ID. Cleanup never adopts a label-census/list-only candidate and never deletes by label, name,
image, prefix or list result.

If neither response nor event yields an ID after the bounded create-settlement interval, the parent
performs one exact-name recovery inspect. Exact name absence proves no current container under that
recovery key at that observation, but is not a daemon-side barrier for the already-issued create and
therefore remains cleanup-uncertain; it cannot make the operation or cleanup successful. A present result becomes cleanup custody
only when its one full lowercase ID, `.Name` equal to `/` plus the exact generated name, exact
invocation and role labels, and immutable configured image reference all match; configuration
details still gate start separately. The parent then removes only the recovered full ID, never the
name. An absent or ambiguous/hung recovery or any identity mismatch is cleanup-uncertain. The name path is
not used when response or event has already yielded custody. A late event observed after name
recovery joins the cleanup union; therefore the one-create union remains bounded to two IDs. Name
recovery can restore cleanup authority only by adopting a present identity-valid full ID; absence
never replaces missing response/event custody or turns an interrupted create or cleanup into success.
This recovery inspect consumes the cleanup reserve's mutually exclusive ten-second
other-child/name-recovery slot: five seconds for normal settlement, two after `SIGTERM` and three
after `SIGKILL` for reap, all capped by the one outer deadline. The branch cannot borrow an ID,
census, watcher, path-helper or scheduling slot. When cleanup latches around a child other than
create, that slot settles the other active child and no name recovery is reachable; after an
ID-less create has consumed its dedicated 15-second settlement slice, there can be no other active
non-watcher child and the same slot is reassigned exactly once to this recovery inspect.

#### Exact Cargo matrix and positive bridge row

The proof controller invokes `/usr/local/cargo/bin/cargo` through `/usr/bin/env -i`. Every
dependency-using row includes `--locked --offline --config net.offline=true --config
'source.crates-io.replace-with="vendored-sources"' --config
'source.vendored-sources.directory="/input/vendor"'` plus its absolute snapshot
`--manifest-path`. Its fixed child environment contains only
`PATH=/usr/local/cargo/bin:/usr/bin:/bin`, `HOME=/wp201-home`, a freshly empty
`CARGO_HOME=/cargo`, a freshly empty `CARGO_TARGET_DIR=/target/current`, `TMPDIR=/fixtures`,
`RUSTUP_HOME=/input/toolchain`, the exact `RUSTUP_TOOLCHAIN`, `RUSTUP_NO_UPDATE_CHECK=1`,
`CARGO_NET_OFFLINE=true`, `CARGO_TERM_COLOR=never`, `LANG=C` and `LC_ALL=C`. Commands run from
`/tmp`, so repository configuration is absent and no source directory is a working directory.

Every Cargo command runs in a newly created proof container. Before the controller writes even its
verification scratch files, it proves `/cargo`, `/target`, `/tmp`, `/fixtures` and `/wp201-home` are
all empty. It then creates only its bounded `/fixtures` verifier files and `/target/current`, and
verifies all writable mount identities and modes before the one Cargo command.
Docker's new private `/dev`, `/dev/shm` and `/dev/mqueue` also belong only to that row. Thus a build
script, proc macro or test cannot leave a Cargo config, wrapper, runner, executable, device
replacement, shared-memory object or queue for a later row. The controller itself uses only
absolute base-image tool paths and never executes from writable mounts. `fmt --all -- --check` runs
once for each manifest with its exact absolute manifest path.

Root authority runs `check --all-targets`, `clippy --all-targets -- -D warnings`,
`rustdoc --lib -- -D warnings` and `test --all-targets` for each feature row:

```text
--no-default-features
--no-default-features --features wp201-internal
```

Runtime proof runs the same check, clippy and rustdoc verbs, plus `test --lib`, for each row:

```text
--no-default-features
--no-default-features --features wp201-internal
--all-features
```

The all-feature all-target check compiles but does not execute the separate WP-200 privileged
kernel harness. Command order is root `fmt`, then the listed root feature rows in order with
check/clippy/rustdoc/test inside each row; runtime `fmt`, then its listed feature rows with
check/clippy/rustdoc/test; coordinator `fmt`, then `check --all-targets`,
`clippy --all-targets -- -D warnings`, `rustdoc --lib -- -D warnings` and `test --all-targets`.
The named positive row below is last.

The exact row IDs, in that order, are:

```text
root-fmt
root-check-none
root-clippy-none
root-rustdoc-none
root-test-none
root-check-internal
root-clippy-internal
root-rustdoc-internal
root-test-internal
runtime-fmt
runtime-check-none
runtime-clippy-none
runtime-rustdoc-none
runtime-test-none
runtime-check-internal
runtime-clippy-internal
runtime-rustdoc-internal
runtime-test-internal
runtime-check-all
runtime-clippy-all
runtime-rustdoc-all
runtime-test-all
coordinator-fmt
coordinator-check
coordinator-clippy
coordinator-rustdoc
coordinator-test
root-positive
```

The proof controller has a closed literal case for exactly those values. Each case executes one
complete fixed Cargo argv directly; it has no array, eval, command string or caller-selected
argument beyond that finite row ID. A second or unknown argument refuses.

The root-authority feature test owns the synthetic policy/bootstrap/state/signature fixtures and
the sole positive uid-zero call chain. Its exact six calls are first policy inspection, first
bootstrap inspection, state-root installation, then after dropping the installed capability,
second policy inspection, second bootstrap inspection and fresh-root inspection. These are the
public `inspect_installed_preparation_policy`, `inspect_preparation_bootstrap`,
`install_preparation_state_root`, `inspect_installed_preparation_policy`,
`inspect_preparation_bootstrap`, `inspect_fresh_preparation_state_root` functions in that order. It
may not call the crate-private owner override or `install_owned`.

After the ordinary root test rows, the controller runs this additional exact row:

```text
cargo test --locked --offline --config net.offline=true \
  --config 'source.crates-io.replace-with="vendored-sources"' \
  --config 'source.vendored-sources.directory="/input/vendor"' \
  --manifest-path /input/source/tools/hosted-migration-root-authority/Cargo.toml \
  --no-default-features --features wp201-internal \
  authority_registry_tests::wp201_root_container_bridge_success \
  -- --ignored --exact --nocapture
```

The positive test has the exact Rust attribute
`#[ignore = "WP-201 root-container bridge row only"]`, so the ordinary
`root-test-internal` row does not execute it. Only `root-positive` supplies `--ignored`; the six-call
chain and marker therefore execute once.

The success line is the byte concatenation `openspell.wp201.` +
`root-bridge-success.v1\n`. It travels only on the bounded attached container stdout. The wrapper
requires the exact named test, exit zero and exactly one complete success line; an absent, partial,
duplicate or stderr marker refuses. A non-root local invocation skips that test without a marker,
so it cannot satisfy this row. The test also exercises the public sampler check that `/proc` and
the fixed `/proc/sys` component have distinct statx mount IDs.

The coordinator wrapper accepts the root proof only when this marker, all feature/reverse-dependency
rows, every row's two independent full-ledger comparisons, exact post-run state, process settlement and cleanup
all succeed. Step 4, not this checkpoint, adds the coordinator's actual preparation machine.

#### Trust boundary, cleanup and no-go

A read-only Docker bind prevents writes from a proof container. It cannot prevent a hostile
process sharing the invoking host uid from modifying and restoring the backing source snapshot,
vendor, toolchain, controller or ledger, and a Docker-socket writer is root-equivalent. Therefore
this source proof explicitly trusts the invoking uid, its already-loaded Node runtime and the local
Docker daemon and requires that no untrusted same-uid or Docker-socket writer run concurrently.
Pre/post ledgers detect ordinary one-way drift but do not claim to defeat write-and-restore. If
either hostile peer is in scope, this design is a no-go: stop and amend the architecture to use an
independently hashed derived image with no host input bind rather than weakening the claim.

One outer `try/finally` owns the acquisition container, the ordered proof-container sequence, the
current event helper, every asynchronous guardian cgroup and every invocation path. It reads the same
held `/proc/uptime` descriptor with bounded positional reads at offset zero, requires exactly two
shortest unsigned decimal second fields with bounded fractional digits plus LF and EOF, converts the
first field into boot-time nanoseconds, samples before and after every state transition, and while a child is live polls it on
a fixed 50-millisecond timer. Host suspend may delay the first post-resume callback by at most that
poll interval, but the fresh boot-time sample latches expiry before any later start or success can be
accepted. This is an acceptance deadline, not a claim that the credential-free setup child performs
no instruction during that interval.

The existing 300-second acquisition and one 1,500-second deadline for the complete ordered proof
matrix are exact. The matrix bound was corrected after an unchanged no-argument run admitted row
23 but exhausted the former 900-second shared active window before that row's Cargo process; it is
one bound for the complete matrix, not a per-row allowance. Each hard deadline has one 160-second cleanup reserve sized for the two-ID
conflict case and bounded retry protocol. Signals or deadline latch cleanup; no later start is
allowed. Each container has one
issued start/attach command and no retry. Pre-start inspection requires `created`, PID zero,
`RestartCount=0` and restart policy `no`. Success requires the same owned ID to inspect `exited`,
exit code zero, PID zero, `Running/Restarting/Paused/Dead/OOMKilled=false`, empty state error and
unchanged restart count. A lost start-client result is refusal even if terminal inspection later
shows zero; it is never retried.

Unknown creation without response, event or valid exact-name recovery custody remains
cleanup-uncertain and is never reported absent. Any response/event-owned full ID is removal
authority even if its configuration is invalid; the exact-name path has the narrower identity gate
above. Configuration validity gates start and success, not response/event cleanup. After each row,
its response/event/name identities settle, every then-held exact ID is removed and proved absent,
the preliminary pre-CLOSE census is classified under the deferred-event rule, and only then does
its watcher close. Any final event
emitted before watcher EOF joins the bounded union and is removed/proved absent before the final
census and the next create.
Final success waits for zero populated owned child cgroups, every guardian reaped, every exact-ID
container absent, an empty exact-label census,
watcher/socket/pipe settlement and absence of every tracked invocation path. Abrupt host loss or uncatchable `SIGKILL`
is not claimed recoverable.

Path removal belongs only to `scripts/path-cleanup-helper.mjs`. It is launched through the captured
`process.execPath`, its fixed resolved script path and no argument, with cwd `/`, environment only
`LANG=C`/`LC_ALL=C`, and this descriptor contract:

| Descriptor | Direction | Contract |
|---:|---|---|
| `0` | none | `/dev/null` |
| `1` | none | `/dev/null` |
| `2` | helper to parent | private diagnostic pipe capped at 4,096 bytes |
| `3` | parent to helper | one cleanup control frame, then EOF |
| `4` | helper to parent | one completion frame, then EOF |

The control bytes are
`openspell.wp201.path-cleanup.v2\n<tmp-or-var-tmp-token>\n<invocation-value>\n<directory-device>\n<directory-inode>\n<cleanup-state>\n`.
The parent token is exactly `tmp` or `var-tmp` and maps only to the two fixed temporary parents;
it is not a pathname. Device and inode are shortest unsigned decimals captured immediately after
the exclusive `mkdir`. Cleanup state is exactly `pre-record`, `partial-acquisition` or
`ledger-backed`. The outer cleanup obligation begins as soon as `mkdir` succeeds, before record
creation; it advances to `partial-acquisition` only after the complete synced `INVOCATION` record,
and to `ledger-backed` only after all setup scratch/cache trees are gone and the complete ledger was
independently verified. Completion is exactly `openspell.wp201.path-cleanup-complete.v2\n`.

The helper reconstructs the one exact directory, opens and revalidates its fixed parent and the
captured directory device/inode, invoking uid/gid and mode `0700`. `pre-record` accepts only an
absent `INVOCATION` or a link-count-one mode-`0600` partial regular file at that exact name; the
other states require the exact valid record. `ledger-backed` additionally requires the complete
inventory/ledger relation before deletion: every source/vendor/toolchain directory and file is
represented by its exact `D`/`S`/`V`/`T` row; the four proof-bound files match their `C` rows; and
the only structural exceptions are the already authenticated `INVOCATION`, fixed-hash
`control/acquisition.sh`, `control` directory, `acquisition` directory and ledger itself, plus the
exact empty `docker/home`, `docker/config`, `{}` config and their parent. `control/proof.sh`,
`control/hostname`, `control/hosts` and `control/resolv.conf` map respectively to ledger paths
`control/proof.sh`, `etc/hostname`, `etc/hosts` and `etc/resolv.conf`. The helper requires every
mode, owner, link count, byte count and digest described by the settled tree above, validates the
ledger's own grammar/body digest, and rejects any missing or additional relative path. For
`pre-record` and `partial-acquisition`, where a
killed Rustup/fetch/vendor or ledger writer can leave arbitrary partial cache entries, the helper
uses a bounded no-follow walk of only this identity-bound directory: at most 131,072 entries, depth
64, 16 MiB total relative-path bytes and 1,024 bytes per path; no nested mount; every entry remains
on the captured filesystem and is owned by the invoking uid/gid. It may unlink regular files,
hardlinks, symlinks, FIFOs or sockets without opening or following them; an unexpected device or
ownership/mount boundary refuses. It changes each verified directory to mode `0700` in postorder,
revalidates the invocation root immediately before fixed recursive removal, removes the directory,
syncs the parent and proves absence. This explicitly covers partial `cargo-home`, `rustup-cargo`,
`vendor`, `toolchain`, source/controller/config construction and ledger scratch. The same-uid
rename/write race is excluded by the explicit trust boundary above; no fd-relative safety claim is
made for Node's recursive removal API. It has no glob, path or environment-selected root and no
generic cleanup mode. Its only other operation is the exact test-supervisor failed-cut protocol
defined below, which requires retained descriptor custody and permanently disqualifies cut success.
The parent repeats the exact-path absence check after helper EOF and reap.

The next implementation step is limited to the stale lock correction, this fixed coordinator
wrapper/helper and boundary/interruption tests, plus the root-owned positive public-bridge test.
It does not add a live target, credential, external adapter, deployable service or write path.

WP-201 proof behavior uses only synthetic assets, fake gateways, fake credentials and disposable
local files. Only the credential-free acquisition container contacts the public crates.io and Rust
component services. No proof container contacts a network, Supabase project, browser, database,
service or Amazon endpoint. The repository's ambient CI may provision PostgreSQL for unrelated
packages. The coordinator package owns its wrapper and routes every bridge-success test through the
reviewed root proof containers even when a local toolchain is installed. Feature compile checks and
pure/refusal tests may use the prior crates' existing entry points; merely building `wp201-internal`
does not satisfy a bridge-success row. Every proof container explicitly uses uid/gid `0:0`, the
exact index reference, `--network none`, read-only rootfs, no capabilities, NNP, the fixed
seccomp/AppArmor boundary and no writable host mount or Docker socket. Ownership-sensitive fixtures
use private tmpfs. Its complete writable mount set, including Docker/kernel pseudo-filesystems, is
frozen above; image root, staged source, vendor, toolchain, controller, ledger and fixed `/etc`
files remain read-only. The no-feature root-authority checks retain their local fast path, but they
do not satisfy bridge success.

The root-authority package's ordinary `scripts/cargo.mjs test` command always uses its pinned
container fallback, even when the host has the exact pinned Rust toolchain. Installation-path tests
exercise the production clock sampler and therefore require `/proc/sys` to be a distinct mount from
`/proc`; a host toolchain version cannot attest that topology, and common CI hosts expose both paths
on one mount. The package `check` command may retain its isolated local-toolchain fast path because
it does not execute the sampler. This routing does not relax the Rust invariant or count as the
separate root-bridge acceptance row.

Before a cold proof, the wrapper selects only `/tmp` then `/var/tmp`, creates and syncs the exact
invocation path/record, and constructs the regular-file-only tracked source snapshot and fixed
controllers described above. It first performs platform-aware inspection of the exact index without
pull. If absent, a separately bounded setup command may pull only that index for `linux/amd64`; the
resulting shared layers are intentionally retained as immutable cache, not proof output. The wrapper
then requires the normalized repo digest, exact selected manifest/config relation, allowed local
inspection ID, platform, config and ordered rootfs graph. Every create uses only the exact index reference
with explicit platform and `--pull never`; no container may pull implicitly.

A first acquisition container runs as the invoking uid/gid and receives only the read-only staged
source/controller plus private bounded tmpfs. It copies the base toolchain,
acquires exactly Rustfmt and Clippy, performs the three locked fetches and creates the single synced
vendor tree. It may not compile, run a build script/proc macro/test or execute proof source. Every
non-path lock entry is a checksummed crates.io source, and boundary tests pin the exact path-package
set. Before acquisition exits, its controller removes setup caches, enforces the frozen
ownership/mode/mount predicates, and emits only the fixed bounded USTAR stream. The wrapper's narrow
decoder reconstructs that stream beneath the exact empty acquisition directory, independently
validates every Cargo checksum mapping and writes the complete source/directory/vendor/toolchain/
control ledger. Networked setup is not proof evidence; its ledger-bound results are explicit
read-only build inputs.

Each separate row proof receives the staged source, vendor, toolchain, ledger, proof controller and
fixed `/etc` files as recursive read-only inputs. Before its one Cargo process and after it exits, the
base-image verifier independently regenerates and matches the complete ledger. Each Cargo row gets
fresh private writable mounts, forced offline directory replacement and the exact
environment/matrix above. No fetched cache is copied into writable storage. Boundary tests compare
the complete platform/image/config, Docker operation and create argv tables; source inventory,
commands and package graph; network/root separation; namespace/security/resource state; read-only
input mounts; complete writable pseudo/tmpfs set; independent ledger matches; and absence of proof
execution from acquisition.

Each container is created, then started, as two operations rather than through `docker run`. Before
create, the wrapper generates a 32-byte random invocation value, durably stores it in its private
directory and requires both an exact Docker list by that immutable invocation/role label and an
exact inspect of the generated role/row container name to report absent.
The wrapper refuses `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` or `DOCKER_CERT_PATH`,
requires the Docker context name `default`, requires its endpoint to be exactly
`unix:///var/run/docker.sock`, records that root-owned mode-`0660` Unix socket's device/inode and
revalidates the socket before every client operation and after watcher closure.
Every Docker client argv places `--host unix:///var/run/docker.sock` immediately after the resolved
Docker executable, so context mutation cannot retarget list, pull, create, start, inspect or remove;
boundary tests reject any client invocation without that exact endpoint. Before sending
create it spawns the owned `scripts/docker-event-helper.mjs`, which validates its closed OPEN-v2
invocation/role/exact-name tuple, connects directly to that Unix socket and requests the fixed Engine
API `/v1.47/events` stream with literal `since=0`, `type=container`, `event=create`, one exact random
invocation-label filter and the separate exact-name `container` filter. The helper caps headers at 8,192
bytes, each frame at 65,536 bytes and the cumulative stream at 1 MiB, then post-filters the exact
role and name. It accepts at most one matching Engine-event JSON frame with one full 64-hex actor ID. Engine
events are external protocol frames, explicitly not WP-201
canonical-record JSON. The duplicate-key-rejecting decoder ignores object key order but allows only
the top-level keys `status`, `id`, `from`, `Type`, `Action`, `Actor`, `scope`, `time` and `timeNano`;
`status`, `id` and `from` may be absent, while all other keys are required. `Type`, `Action` and
`scope` must be `container`, `create` and `local`; optional `status` must be `create`; optional `id`
must equal `Actor.ID`; optional `from` is a bounded string. `Actor` has exactly `ID` and `Attributes`;
its ID is full lowercase 64-hex and its string-to-string attribute map has at most 32 entries and
must contain the two exact requested labels plus string `name`; `from` plus every attribute key/value is at most 4,096
UTF-8 bytes. `time` is a nonnegative JSON safe integer. Because real Engine nanosecond timestamps
exceed JavaScript's safe range, the duplicate-aware raw decoder accepts `timeNano` only as a
canonical unsigned one-to-19-digit JSON integer token without converting it through `Number`.
Neither time is used as identity or deadline evidence. Arbitrary HTTP chunk splits are accepted;
each LF-delimited frame contains exactly one JSON object with no trailing bytes inside that frame.
Valid different-invocation frames are ignored under the bounded cumulative stream, while a second
matching-invocation frame, duplicate/unknown/missing field, non-string value or over-limit frame
refuses. A fixed real-shaped Engine API fixture covers this
decoder. After connecting to the fixed socket, writing and flushing the complete HTTP request, and
parsing and requiring HTTP 200 plus complete valid headers, the helper writes
`openspell.wp201.docker-event-ready.v1\n` to its private ready pipe. The wrapper must receive that
daemon-acknowledged frame before create; the fixed backlog cursor narrows but does not claim to
eliminate the daemon's header-to-subscription/global-retention race. After the create event arrives,
the helper emits the bounded validated ID on its
separate event pipe. This is the independent
same-daemon settlement channel. The create request contains those labels. Exact full-ID-plus-LF
stdout from the one create client is captured as cleanup custody after that client is reaped;
status zero and empty stderr are additional start/success predicates, not deletion-authority
predicates. A caught wrapper signal is latched; it does not interrupt an in-flight create client
during the first five-second settlement slice, after which the fixed TERM/KILL/reap rule applies
even without a response. No later start is permitted after the latch. On
response loss or a malformed response, the wrapper boundedly continues the already-established
event stream after the client is reaped. An exact create event supplies its full daemon-issued ID;
the wrapper cross-checks that ID against repeated exact-label inventories. It never treats a
momentarily empty query as proof of nonoccurrence. If neither the create response nor the event
stream supplies an ID by the end of the 15-second create settle/TERM/KILL-reap slice, capped by the
common hard deadline, the exact-name recovery inspect above either proves that name absent or
adopts its fully identity-validated ID for cleanup only; an ambiguous recovery remains
cleanup-uncertain. None of those outcomes can emit success. Label listings alone are absence
diagnostics only. Every unique response-, event- or valid name-recovery-bound ID is exact cleanup
ownership; a conflict refuses success and every held ID is removed and proved absent. `docker
inspect` must match the immutable
invocation/role labels, the representation-bound container image identity, exact argv, network/security/resource/mount
configuration and created state before start or success; mismatch refuses those gates but does not
discard exact-ID removal authority. Cleanup and all later mutation address only the bounded set of
at most two custodied full IDs, never a name or label. Multiple inventory-only diagnostic
candidates refuse success without being adopted.

The deterministic interruption seam is internal and closed. This package has no production or
deployable entrypoint: `scripts/test.mjs` is the sole no-argument, nondeployable proof orchestrator.
It accepts no CLI, environment or descriptor-selected case and unconditionally runs both the pure
Vitest fault-model suite and the smaller real-Docker integration suite. Docker unavailability or a
failed real suite is a proof failure, never a skip or fallback into a fake path.

The pure suite drives the same state machine, argv builders, parsers, custody logic, deadlines and
cleanup-budget reducer through one sealed test-only driver selected solely by a closed
source-literal case enum. It covers delayed HTTP headers while request bytes are already flushed,
and proves READY/create remain blocked until valid complete `200` headers; it also covers status
`500`, malformed headers, EOF-before-headers, lost/malformed/overflowing create responses,
missing/duplicate/wrong-role/conflicting/delayed events, empty census followed by late acceptance,
global-backlog eviction followed by exact-name cleanup recovery, exact-name absence/identity/
ambiguity outcomes, namespace-gate embedded NUL, unterminated tail, over-cap, missing/reordered/
duplicate line and trailing-byte frames,
every hung/error child in pull, fetch, proof, list, inspect, start, remove, watcher and path cleanup,
signal/deadline races, the exact-ID removal retry and cleanup-budget exhaustion. The fake supplies
only finite typed operation outcomes and virtual boot-time advances: it cannot inject a pathname,
executable, argv, callback, parser or alternate implementation.

`scripts/docker-integration.mjs`, invoked unconditionally by `test.mjs` outside Vitest, uses the
hardcoded real driver and actual `/usr/bin/docker`. It covers one normal full lifecycle through
HTTP-200-before-READY, equal response/event custody, inspect, start/attach, removal, exact absence,
empty pre-CLOSE census, CLOSE/helper reap and final census/socket check; actual image/container
inspect representations, event JSON, create/remove stdout and both not-found classifications; a
no-create watcher that proves the daemon's real header/close behavior; and the three real create
cuts: before issue, after daemon acceptance and full-ID capture but before parent delivery, and
after parent custody but before inspect/start. The closed `scripts/interruption-harness.mjs` owns
those three pause points. `scripts/docker-integration.mjs` is the outer supervisor and starts one
fresh release-gated guardian cgroup per source-literal case.

The normal matrix's completed acquisition invocation remains the one authenticated copy source
while the cuts run. Before each cut, the supervisor creates one new exclusive invocation under the
same fixed-parent policy and uses one closed, bounded, no-follow copier to construct a fresh
`ledger-backed` root. The copier copies bytes with ordinary bounded reads and exclusive writes; it
never hardlinks, reflinks, clones, symlinks, renames or bind-mounts an input into the destination.
It rebuilds the new `INVOCATION` record, Docker home/config tree and fixed structural files rather
than copying their authority. Before and after copying it verifies every `D`/`S`/`V`/`T`/`C` row,
source object ID, Cargo checksum membership, toolchain authority tuple, controller hash, mode,
owner, link count, size, digest, device and mount identity, all fixed counts and all byte totals. It
syncs and independently re-verifies the complete destination before handoff. One opaque in-memory
root token is consumed by the first spawn attempt, including a failed attempt; a root is never
offered to another case. At most the acquisition root and the current case root exist at once, and
the next case root is not created until the prior case's path and process cleanup have settled.

Each case construction has its own absolute `CLOCK_BOOTTIME` deadline: 300 seconds of active copy
work plus a 25-second reserve containing exactly 15 seconds for the existing state-specific path
helper and parent absence check and 10 seconds scheduling reserve. The wrapper samples before and
after every at-most-1-MiB read or write and every state transition. Exclusive directory creation
enters `pre-record`; only the complete synced `INVOCATION` record advances to
`partial-acquisition`; only scratch-free complete-tree and ledger reverification advances to
`ledger-backed` and creates the one-use handoff token. A signal, active expiry or copy failure runs
the existing authenticated cleanup helper with the current exact state. A construction
hard-deadline or residue failure permanently fails the real suite and cannot borrow time from the
later harness.

Each harness attempt receives a new 900-second active proof budget plus the existing exact
160-second inner cleanup reserve. The outer supervisor adds one disjoint 50-second post-reap
acceptance interval, so its authoritative cut deadline is 900 plus 210 seconds. That interval is
the exact non-overlapping sum of ten seconds for an accepted-ID absence inspect when applicable,
ten seconds for the independent exact-name census, ten seconds for the independent label census,
five seconds for watcher identity, process-group and both-parent pathname absence, ten seconds for
retained root/ledger custody settlement, and five seconds scheduling reserve. An inapplicable
accepted-ID slot remains unused and cannot be borrowed. Each of the three Docker slots uses the
fixed five/two/three normal/TERM/KILL/reap split; expiry or ambiguity fails the cut.
The supervisor's held boot-time clock establishes the pre-spawn active, inner-settlement and outer
hard deadlines; it
latches/signals at active expiry, rejects any success after that instant and kills/reaps the process
group within the first 160 reserve seconds. At its first instruction the harness opens its own held
boot-time clock and establishes the same 900-plus-160-second inner deadline as an additional
defense; those later local instants can never extend the supervisor's earlier inner bound. The
outer 50 seconds are unreachable to harness work and begin only after harness reap and all five
output pipes reach EOF. The normal 28-row matrix has a separate 1,500-plus-160-second deadline. These
four proof deadlines are independent; no cut borrows a slot or unused time from construction, the
matrix or another cut. The supervisor starts a cut's 900-plus-210-second deadline immediately
before consuming its token
and attempting the first harness spawn, not after child readiness. A synchronous spawn error or a
partially established process burns the token; when no Docker create has yet been issued, the
reserve's otherwise unused 15-second create-settlement slice belongs to exact harness process-group
TERM/KILL/reap settlement before state-specific path cleanup. No harness owns normal cleanup until
spawn identity is positively established, and no failed spawn can be retried with that root.

The supervisor resolves the fixed case launcher and samples the authoritative cut start before it
marks the handoff `attempted`; once it enters the launcher, it never abandons or reuses the token.
After deleting the token, every failure path through child creation, handoff settlement and
release privately registers the complete child, cleanup, custody and handoff identity against the
exact error object before throwing it. It exposes no capability as an error property.
The supervisor can consume that private claim exactly once; forged or replayed errors return no
authority, and descriptor-settlement failure is returned as evidence without losing the claimed
launch record. A pre-launch failure instead consumes the still-available token through a distinct
private no-child cleanup claim.

The supervisor installs the normal bounded five-pipe observer before inspecting process identity
and waits for the exact `spawn` or `error` event. A returned child settles through the otherwise
unused 15-second create slice: five seconds normal, five after `SIGTERM` and five after `SIGKILL`,
capped by the cut's inner deadline. This failure occurs after an OS spawn may have run; it never
proves that Docker create was unissued. Structural settlement is distinct from semantic validity:
the authenticated reap receipt is either `not-created`, or it proves child close, process-group
absence, parent fd-3 writer closure and EOF on stdout, stderr, identity, accepted-ID and audit
pipes. If a primary error or receipt-transition clock failure has already made the run permanently
failed, the one-use structural receipt is consumed by a distinct failed-reap transition. That
transition can cross the expired normal outer boundary, never grants success, and enters only the
separate 130-second failed-cut reducer. Recovery adopts a fresh boot-clock descriptor for the whole
teardown and rotates that owned descriptor after a read failure. The reducer alone owns full-ID
accepted-ID validation, exact-name recovery, bounded removal/absence, final censuses, the
custody-bearing path helper, parent absence and descriptor settlement. Every child uses the exact
reducer slot deadlines. An unreaped cleanup child records explicit residue, skips all remaining
pathname or Docker authority, and advances only to the mandatory parent-descriptor settlement;
completion remains `failed-residue`. Cleanup failure is retained alongside the exact original
error; clean recovery rethrows that same object.

The outer no-argument test orchestrator gives the complete Docker integration child exactly 7,490
seconds. That is the non-overlapping sum of 460 seconds for initial source staging, 460 seconds for
image authentication, 460 seconds for dependency acquisition, 1,660 seconds for the normal matrix,
three times 325 seconds for fresh-copy construction plus 1,110 seconds for a cut, one mutually
exclusive 130-second mandatory failed-cut teardown, and 15 seconds for final path cleanup. The cut
loop aborts after its first failure, so at most one failed-cut teardown can execute. A clean run can
consume at most 7,360 seconds of those internal allocations; the remaining fixed 130 seconds is
failure-only teardown, not a phase budget and cannot be borrowed by an inner operation. Ordinary CI
invokes this package separately with no forwarded Vitest argument.

For each completed case root the supervisor opens and authenticates the root twice with
`O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`: one retained custody descriptor and one handoff
descriptor. It also retains an authenticated read-only descriptor for the complete ledger so a
failed-case cleanup can validate a remaining subset even if the ledger pathname has already been
unlinked. The two root descriptors, the canonical pathname, fixed parent, invocation record,
device, inode, statx mount ID and complete-ledger SHA-256 must agree. The supervisor derives the
invocation, parent token, canonical path, exact container name, labels and proof argv only from this
pre-spawn custody; no harness frame supplies cleanup, Docker or pathname authority. The spawn file
action installs the handoff descriptor as child fd `7`, after which the supervisor immediately
closes its handoff copy and keeps its separate custody descriptors through harness settlement.

The otherwise absolute no-case-through-argv rule has one closed test-only exception: the supervisor
constructs exactly one of these three
complete argument vectors, with no concatenation, interpolation or trailing token, under the fixed
package working directory, detached process-group setting, descriptor table below and environment
containing exactly `LANG=C` and `LC_ALL=C`:

```json
["<captured-process.execPath>","--input-type=module","--eval","import{runBeforeIssueCut}from\"./scripts/interruption-harness.mjs\";await runBeforeIssueCut()"]
["<captured-process.execPath>","--input-type=module","--eval","import{runAfterDaemonAcceptBeforeDeliveryCut}from\"./scripts/interruption-harness.mjs\";await runAfterDaemonAcceptBeforeDeliveryCut()"]
["<captured-process.execPath>","--input-type=module","--eval","import{runAfterParentCustodyBeforeStartCut}from\"./scripts/interruption-harness.mjs\";await runAfterParentCustodyBeforeStartCut()"]
```

Those literal module programs are the complete case-selection identity; no case string is passed to
or parsed by the harness. The harness exports exactly those three no-argument entry functions, has
one shared one-use entry latch, and exposes no `run(case)`, selector map, default executable entry,
caller callback or driver. Each export reaches its own private literal pause predicate and emits its
own literal case token. The common lifecycle and cleanup implementation remains private. Node ESM
evaluation makes `process.argv` contain only the Node executable in this launch form; the harness
therefore does not inspect `process.argv`, `process.execArgv`, environment or any descriptor to
select a case. These three fixed programs are internal fault-injection launch identities, not a
generic command surface. They cannot select a fake driver or alter the production lifecycle.

Every harness launch uses this exact descriptor table. No harness descriptor or open file
description referring to the invocation-root identity is inadvertently inherited by a Docker
client, event helper, normal path helper, container or other subordinate process. A descendant may
reuse numeric fd `7` for an unrelated pipe; the invariant is that no descendant descriptor matches
the retained root's device, inode and mount ID. The sole deliberate exception is the permanently
failed supervisor teardown helper defined below, which receives separate root and ledger
capabilities on fds `5` and `6` after every harness process has reaped:

| Descriptor | Direction | Contract and total cap |
|---:|---|---|
| `0` | none | `/dev/null` |
| `1` | harness to supervisor | terminal stdout, 64 bytes |
| `2` | harness to supervisor | terminal stderr, 128 bytes |
| `3` | supervisor to harness | one release frame, 160 bytes, then EOF |
| `4` | harness to supervisor | one identity frame, 320 bytes, then EOF |
| `5` | harness to supervisor | one accepted-ID frame, 128 bytes, then EOF |
| `6` | harness to supervisor | operation-audit stream, 512 bytes, then EOF |
| `7` | supervisor to harness | one authenticated, fully verified `ledger-backed` invocation-root directory capability; no byte protocol |

At the first harness instruction, before installing timers or signal handlers, creating a promise,
opening the watcher or constructing any child, fd `7` must be an invoking-user-owned mode-`0700`
directory whose `/proc/self/fdinfo/7` has the exact Linux flags `02700000` and one shortest-unsigned
decimal `mnt_id`. The exact production spawn wrapper must prove on the captured Node runtime that
its deliberate fd-`7` file action produces those flags and that a later child does not inherit the
descriptor. The harness reads the bounded `INVOCATION` record relative to fd `7`, derives only the
two literal possible canonical paths, requires the selected parent/path no-follow reopen to match
the fd's device, inode and mount ID, the fixed parent identity and the record, and independently
requires the alternate-parent path for that same invocation value to be absent. It then retains that reopened
`O_CLOEXEC` directory handle, closes fd `7`, proves fd `7` absent, and only then installs the rest of
the lifecycle. `/proc/self/fd/7` may be used only for this admission read; it is never passed to
Docker. The harness re-verifies the complete root and ledger immediately before create, reopens and
compares the canonical path to the retained identity before and after every Docker client, and
keeps its retained handle until normal path cleanup and canonical absence are proved. Admission
provides assets only and cannot select or relabel any of the three literal cases.

The three exact case tokens are `before-issue`, `after-daemon-accept-before-delivery` and
`after-parent-custody-before-start`. The release frame is
`openspell.wp201.real-cut-release.v2\n<case>\n<challenge>\n`, where `<challenge>` is the exact
64-lowercase-hex freshness value from the signal acknowledgment below. Its maximum size is 137
bytes. The harness emits the accepted-ID frame and then the
identity frame only after its event watcher has produced READY and the source-fixed case-specific
pause point has been reached; the complete identity frame is the reached-cut attestation:
`openspell.wp201.real-cut-identity.v2\n<case>\n<invocation-value>\n<tmp-or-var-tmp-token>\n<directory-device>\n<directory-inode>\n<directory-mount-id>\n<complete-ledger-sha256>\n<watcher-pid>\n<watcher-proc-starttime>\n`.
Device, inode, mount ID, PID and start time are shortest unsigned one-to-20-digit decimals; the
invocation value and ledger digest are lowercase 64-hex. The longest valid frame is 316 bytes. Every root field must equal the
supervisor's retained pre-spawn custody, and no frame field grants authority.
The PID and Linux `/proc/<pid>/stat` field-22 start time are shortest unsigned decimals; the parent
token is exactly `tmp` or `var-tmp`. The accepted-ID frame is
`openspell.wp201.real-cut-accepted-id.v1\n<value>\n`, where value is exactly `none` for
`before-issue` and the daemon-issued 64-lowercase-hex ID for the two accepting cuts. For an
accepting cut the harness completes and flushes that whole frame before its reached-cut identity
frame. At `after-daemon-accept-before-delivery`, the interception seam has captured the full ID but
has not delivered it to the wrapper state machine. At `after-parent-custody-before-start`, delivery
and immutable custody recording have completed but no inspect or start/attach dispatch has begun.
At `before-issue`, the exact `none` frame is flushed after READY while create remains unissued.
Partial, duplicate, reordered, unknown, over-cap or trailing bytes in
any of these single frames fail the cut. The supervisor continuously drains fds `1`, `2`, `4`, `5`
and `6`, requires the complete audit-open frame, validates the watcher PID/start-time identity in
`/proc`, requires the case-appropriate accepted-ID frame to precede the reached-cut identity frame,
and compares the complete identity frame to the invocation path, exact name, labels, device, inode,
mount ID and ledger digest it derived from its retained pre-spawn custody. A mismatch fails the cut
and none of the child-supplied values becomes a cleanup target. It then sends exactly one `SIGTERM`
to the still-unreaped harness PID whose child identity it recorded at spawn. The installed
production signal handler first atomically latches the same cleanup
and no-later-dispatch state used outside tests. Only after that latch and exact `SIGTERM`
validation, it synchronously obtains 32 random bytes from the captured native runtime, converts
them to one private immutable 64-lowercase-hex challenge, then synchronously writes and flushes
this exact 116-byte frame on fd `6`:

```text
openspell.wp201.real-cut-signal-latched.v2
SIGTERM
<challenge>
```

The first signal is final: a repeated signal cannot replace the latch or mint or acknowledge a
second challenge. Randomness or acknowledgment-write failure permanently refuses. The supervisor
uses a strict token-bound parser for the complete audit-open plus acknowledgment prefix and the
source-fixed case before it may construct any release bytes. The first successful parse permanently
binds that child token and case to one branded acknowledgment; reparsing the same bytes or any other
acknowledgment for that token fails. Only the proof engine may construct a release, deriving the case
from that branded acknowledgment with no separate case selector. The final audit parser must bind the same branded
acknowledgment and challenge, while its terminal receipt omits the challenge. Only after the
supervisor receives that complete acknowledgment may it write the matching release frame and close
fd `3`; consuming release merely unblocks the case pause and cleanup must observe the already-latched
state. A release queued before acknowledgment cannot contain the subsequently minted challenge and
must fail even when Node dispatches its pipe callback after the signal callback. Missing EOF,
partial, duplicate, unknown, over-cap or trailing release bytes fail. Signal delivery failure,
harness exit before acknowledgment, missing/duplicate/wrong-signal acknowledgment, challenge
mismatch, release before acknowledgment or release consumed without the latch fails the cut.
The challenge is freshness and ordering evidence only. It may occur only on private fds `6` and `3`
and in the proof engine's private acknowledgment receipt/release builder; it never enters Docker
arguments, names, labels, IDs, cleanup cursors, pathname/root custody, public receipts, terminal
output or diagnostics.
For `before-issue`, release leaves create unissued. For
`after-daemon-accept-before-delivery`, release transfers the already captured immutable full ID into
response cleanup custody only, with every configuration/start/success gate permanently false. For
`after-parent-custody-before-start`, the existing custody is preserved and cleanup resumes at its
next monotone state. No release path discards an accepted ID or re-enters normal execution.

All three cases exercise exactly the proof role `root-bridge-proof-v1` and row `root-fmt`; no
acquisition container is reachable in the interruption harness. The supervisor therefore derives
the sole name as `openspell-wp201-<invocation-value>-proof-root-fmt` and the sole role filter from
that source-fixed case mapping rather than from harness-selected telemetry.

The audit stream opens with exact bytes `openspell.wp201.real-cut-audit-open.v1\n`. Immediately
before either allowed start/attach child spawn, the single Docker dispatcher must synchronously
write and flush
`openspell.wp201.real-cut-start-attach.v1\n<role>\n<owned-full-ID>\n`; a partial/failed write latches
refusal and makes the spawn unreachable. `<role>` is the exact role label already selected for that
container. Once the signal latch is set, the dispatcher makes create, configuration-inspect and
start/attach spawns unreachable. Any attempted post-latch call must synchronously emit respectively
`openspell.wp201.real-cut-forbidden-create.v1\n`,
`openspell.wp201.real-cut-forbidden-config-inspect.v1\n` or
`openspell.wp201.real-cut-forbidden-start-attach.v1\n` and refuse without spawning; cleanup remove,
absence and census operations remain reachable through their separate closed cases. After cleanup
has settled every child including the event watcher, proved canonical path absence and closed its
retained invocation handle, the harness writes `openspell.wp201.real-cut-audit-close.v1\n`, closes
fd `6`, then closes fds `4` and `5`, emits its terminal streams and exits. Unknown, duplicate,
out-of-order, partial, over-cap or trailing audit frames, close before watcher, invocation-handle or
path settlement, or EOF before the close frame fail. Each interruption cut
requires exactly audit-open, signal-latched and audit-close with zero start/attach or forbidden
frames. Static boundary tests prove every
allowed start/attach argv reaches only this dispatcher and that no alternate child-spawn site can
issue it. They also prove the three reached-cut frames are emitted at distinct closed source sites
with the exact before-create, captured-not-delivered and delivered-custody predicates above; a case
token cannot be relabeled at runtime, and every create/configuration-inspect/start spawn checks the
same signal latch before child construction.

For each cut, the required terminal vector is exit status `73`, empty stdout and stderr exactly
`openspell.wp201.interrupted-before-start.v1\n`; the exact bridge-success marker must be absent from
both streams. After reaping the harness, the supervisor requires EOF on all five harness-output
pipes (fds `1`, `2`, `4`, `5` and `6`) within the inner deadline, then enters the outer 50-second
post-reap interval. In its allocated slots it requires the accepted ID absent when supplied, the
independently queried exact-name and label censuses empty, the original watcher PID/start-time
identity absent (a reused PID with a different start time does not match), the harness containment
empty and removed, and the derived invocation path absent under both fixed parents.
The before-issue cut instead requires the exact name and label to have remained absent. Every
ID-owning cut must have the harness itself remove and prove absent that exact ID. The supervisor
then enters the interval's dedicated ten-second custody slot. Before any cut can pass,
it positionally rereads its separately retained ledger descriptor from offset zero in
at-most-1-MiB chunks, samples boot time before and after every chunk and descriptor transition,
requires the original device, inode, uid/gid, mode, frozen at-most-16-MiB size and complete digest
with link count zero, and requires EOF at the authenticated size. It then requires its separately retained root
descriptor to preserve the original device, inode, mount ID and uid/gid while being empty, unlinked
and link-count zero. Before closing either descriptor, it scans its own complete descriptor table
and requires exactly its one recorded root descriptor and one recorded ledger descriptor to match
those identities, with no duplicate. Only after those retained-capability assertions does it close
the ledger and root descriptors, require both recorded numbers to produce `EBADF`, rescan and
require neither identity anywhere in its descriptor table. A renamed root, renamed ledger,
still-linked object, descriptor leak or byte drift therefore fails the cut even when both canonical
pathnames are absent. Failure before either close retains both capabilities for the fixed failed-cut
helper. A close failure or identity match after the first close irrevocably fails the cut and enters
descriptor-only settlement: using the recorded identities, the supervisor enumerates and closes
only its own matching descriptors and proves them absent, without pathname deletion or the
failed-cut helper. That settlement uses the failed teardown's existing ten-second root/ledger
descriptor slot; its otherwise inapplicable helper slot remains unused and cannot be borrowed.
Only after any required success assertion fails, the failed verdict is irrevocably recorded, the harness guardian is
reaped, its complete cgroup is proved empty and removed, and all harness pipes are at EOF may fixed supervisor teardown
begin. A child-supplied accepted ID is eligible for supervisor removal only after an independent
full-ID inspect matches the supervisor-derived exact name, invocation and proof-role labels,
immutable image reference and expected proof role. Name and label censuses remain diagnostic and
never grant deletion authority. When no child-supplied ID passes that gate, the supervisor may run
exactly one bounded inspect using its source-derived exact container name. Absence grants no
custody; a present result grants removal authority only to the returned full ID after that same
name, invocation/role-label, immutable-image and proof-role validation. Removal always addresses
the adopted full ID, never the name or label, and uses the exact two-remove/two-absence protocol.
Their adoption results are mutually exclusive and can retain at most one ID because the
supervisor-derived name is unique. Teardown is reported separately and can never convert that cut
to success. Thus a harness that ignores the cut, starts the container and later removes all residue
still fails its exact terminal vector and audit.

Failed-case pathname teardown is a second closed protocol in
`scripts/path-cleanup-helper.mjs`; it is not a normal harness cleanup state and cannot be selected
by argv or environment. The supervisor invokes it only after the conditions above, with the fixed
script/cwd/environment and this bounded control frame on fd `3`:

```text
openspell.wp201.path-cleanup-failed-cut.v1
<tmp-or-var-tmp-token>
<invocation-value>
<directory-device>
<directory-inode>
<directory-mount-id>
<complete-ledger-sha256>
```

Its exact descriptor table is `/dev/null` on fds `0` and `1`, a 4,096-byte diagnostic pipe on fd
`2`, the at-most-512-byte control pipe on fd `3`, a 64-byte completion pipe on fd `4`, a root
directory capability with exact Linux flags `02700000` on fd `5`, and a regular-ledger capability
with exact Linux flags `02500000` on fd `6`. The root descriptor must match the supervisor's
original device/inode/mount ID and uid/gid. The ledger descriptor must match its pre-handoff
device/inode/uid/gid, mode `0444`, bounded size and complete digest; its link count may only
move from one to zero after unlink. The helper reads it positionally from offset zero, requires EOF
at the authenticated size and never trusts or changes its shared file position.

Those held ledger bytes are the complete member allowlist even when the ledger pathname has already
been unlinked. If the canonical root still resolves to the retained device/inode/mount identity,
every remaining regular file must retain its authenticated type, owner, device, mode, link count
one, size, bytes and digest. Every remaining directory must retain type, device and uid/gid and may have only its
original authenticated mode or cleanup mode `0700`; the root additionally matches the retained
inode and mount ID. Descendant-directory inode values are not part of the ledger and are not
compared to unavailable pre-delete values. Its current link count, size and timestamps
are not compared to stale pre-delete values. Its children and subdirectories instead must equal a
subset of the authenticated inventory, and its link state must be consistent with that observed
subset. The held root may likewise show only cleanup-induced directory metadata changes. No content
or path may be added. Extras, foreign ownership, a device, a nested mount or any changed regular
member refuse. The helper may then finish the same bounded no-follow postorder removal. If the canonical
path is absent, success additionally requires the retained directory to be empty, link count zero
and unlinked; a still-linked, renamed or nonempty retained directory refuses. If the canonical path
resolves to a different identity, the helper deletes nothing. Exact completion is
`openspell.wp201.path-cleanup-failed-cut-complete.v1\n`, but immediately before emitting it the
helper must positionally revalidate the retained ledger's original device, inode, uid/gid, mode,
size, bytes and digest with terminal link count zero and must revalidate the retained root's
original device, inode, mount ID and uid/gid while empty, unlinked and link-count zero. Any external
ledger hardlink or rename therefore refuses even if the root pathname has disappeared. Any
invocation of this protocol statically disqualifies cut success. The supervisor's ten-second
root/ledger descriptor phase runs unconditionally after the helper slot whether the helper reports
completion, refuses, is killed or fails to reap. For a clean completion it independently repeats
both retained-capability checks, requires exactly its one root and one ledger descriptor and no
identity-matching duplicate in its descriptor table, closes its originals, requires both recorded
numbers to produce `EBADF`, and requires neither identity in a final scan. On helper refusal or any
identity, content, link-count or descriptor-count mismatch before close, it instead enumerates and
closes only supervisor descriptors matching the two pre-recorded root/ledger identities and proves
neither identity remains. A close, `EBADF` or final-scan anomaly takes that same descriptor-only
route. Every such mismatch and every helper failure remains cleanup failure; this phase grants no
pathname authority and cannot convert the failed cut or teardown to success. Thus the supervisor
always settles its retained identities, while an unreaped helper or external filesystem link remains
explicit residue rather than a zero-residue claim.

This failed supervisor teardown begins a separate 130-second absolute boot-time deadline only after
the failed verdict and complete harness reap. Its non-overlapping allocation is 10 seconds for
child-supplied accepted-ID validation when such a complete frame exists, 10 seconds for the one
exact-name recovery inspect when no ID was adopted, 40 seconds for at most one adopted ID's
two-remove/two-absence sequence, 10 seconds each for final exact-name and label censuses, 10 seconds
for the failed-cut helper, 5 seconds for parent absence, 10 seconds for root/ledger descriptor
settlement, and 25 seconds scheduling reserve. Every ten-second Docker slot uses the fixed
five/two/three normal/TERM/KILL/reap split; the helper uses four/three/three. Expiry or an
unreaped child remains cleanup failure, never permission to continue or claim success.
Delayed subscription remains in the deterministic driver because a compliant real daemon cannot be
forced reproducibly into that scheduling race.

Executable failed-teardown tests create an external hardlink and an external rename of the ledger
and require refusal, duplicate each supervisor custody descriptor in turn and require refusal plus
descriptor-only settlement, and prove an ordinary interrupted cleanup reaches terminal link count
zero for both retained objects before closing their sole supervisor descriptors.

Static boundary tests prove the real no-argument path constructs only the real driver, cannot import
or select a fake case, and does not read CLI arguments, test environment or the harness descriptor.
They also compare all three complete supervisor launch vectors, cwd, exact environment, detached
setting and fd-`7` descriptor table byte for byte, prove there is no fourth importer or dynamically
constructed eval source, require the harness's one-use latch, and bind each exported no-argument
entry to its distinct literal predicate and attestation site.
Path-cleanup cases use the actual filesystem and fixed helper against test-owned invocation
directories. Tests never claim zero residue after an ID-less mutation timeout; they require the
cleanup-uncertain refusal.

Executable cut tests additionally cover three distinct fresh roots; a missing/closed fd `7` and a
wrong file, socket, access mode, flags, owner, mode, device, inode, mount ID, record, ledger or
inventory; a root absent, renamed, substituted, nested-mounted or simultaneously present under
both fixed parents; swapped roots and replayed one-use tokens; every identity-v2 field mismatch,
ordering, cap, partial, duplicate and trailing frame; immediate harness closure of fd `7`; and
absence of any matching root device/inode/mount identity in every child class even when an unrelated
descriptor reuses numeric fd `7`. They interrupt the normal helper after every directory chmod,
unlink and rmdir boundary and prove the failed-cut subset teardown finishes only while the case
remains failed. They also
prove deletion while the harness and supervisor handles remain open, closure of both handles,
supervisor refusal of an accepted ID with a wrong name/label/image, failure before identity and
after accepted ID, absence of any harness acquisition path, and unchanged literal argv, cwd,
environment and case-selection rules.

The watcher lifecycle has one sequence on success, refusal and interruption: establish the socket
connection and flush the request; receive READY; issue at most one create; reap the create client;
settle response/event identities; if both are absent, run the one exact-name recovery inspect in its
branch-reassigned slot and keep the watcher open so any late matching event joins the bounded union;
inspect and, only when every success gate holds, start/attach and reap the container; remove and
absence-check every then-known unique response-, event- or valid name-recovery-custodied full ID;
run the preliminary exact-label census; send CLOSE; accept any one final matching event emitted
before helper EOF into the same at-most-two-ID union; require helper/event/ready pipe
EOF and reap the helper; remove and absence-check any newly learned final ID; then perform the final
empty exact-label census and socket identity check. CLOSE is the event-custody linearization point:
the helper parses and emits every complete matching frame already received before processing CLOSE,
then closes the socket and can emit no event after its event pipe EOF. A newly emitted ID after the
preliminary census consumes the remaining per-ID slots before the one post-CLOSE census; the
preliminary census is not rerun. If the preliminary census is empty, it passes. If it contains only
an ID supplied by the sole matching event after that census started, that event—not the list row—
confers custody and the ID is deferred until watcher closure. Any other nonempty row latches
cleanup uncertainty, never deletion authority; the watcher is still closed and final checks still
run, but success is impossible. A second matching event at any time refuses and is cleanup-uncertain.
Paths that never issue create still close and reap their established
watcher with zero events. No row starts a later watcher until the prior watcher, all IDs and both
censuses have settled. The ten-second final check runs only after watcher reap and all final-ID
cleanup and also revalidates the socket.

The wrapper holds and strictly parses `/proc/uptime` through bounded positional reads at offset zero,
derives one absolute Linux boot-time deadline per image acquisition, dependency acquisition and the
complete proof matrix, samples around every transition
and polls at most every 50 milliseconds while a child is live. Active budgets are 300 seconds for
either acquisition and 1,500 seconds for the complete normal proof matrix; each hard deadline adds exactly 160 seconds of cleanup
reserve. This is the inner driver and normal-matrix allocation; only the three outer interruption
supervisors add their disjoint 50-second post-reap acceptance interval and therefore use 210 seconds.
Every child from the closed operation table is an asynchronous owned guardian cgroup capped
to the remaining absolute deadline. At active-budget expiry or the first caught `SIGINT`, `SIGTERM`
or `SIGHUP`, cleanup is latched and later signals cannot
reenter or bypass it. A Docker create client is first allowed at most five seconds to settle so its
response-bound immutable ID is not discarded; it then receives `SIGTERM`, at most five seconds,
`SIGKILL`, and at most five more seconds to reap. Other active children begin with that same five-
second normal-settlement interval, then receive `SIGTERM`, at most two seconds, `SIGKILL`, and at
most three seconds to reap. An ID-less create after forced settlement
is unresolved until the one exact-name recovery inspect. Only a present, identity-valid result can
add cleanup custody; absent, ambiguous, hung or identity-invalid recovery is terminally
cleanup-uncertain because no client-side watcher close, name inspect or census is a daemon-side
completion barrier for the already-issued create.

The reserve is a non-overlapping sum: 15 seconds for create settlement/TERM/KILL/reap, 10 for the
mutually exclusive other-active-child or post-settlement exact-name-recovery inspect, 80 for at most
two exact IDs, 10 for the pre-CLOSE label census, 10 for watcher
closure, 10 for the post-CLOSE census plus socket revalidation, 15 for the path helper including the
parent's final absence check, and 10 seconds scheduling reserve. Each ID receives at most four
ten-second Docker slots. Slot one issues force-remove attempt 1 to that exact ID; slot two always
runs an exact absence inspect. If and only if that inspect reports present or is ambiguous/hung,
slot three issues force-remove attempt 2 to the same ID and slot four performs the mandatory final
absence inspect. No ID receives a third remove. A first removal failure cannot suppress the first
absence probe, and a first absence ambiguity cannot suppress the retry. Only the frozen exact
not-found classification after attempt 1 or the final probe releases custody; otherwise cleanup
fails. Each ten-second Docker slot allows five seconds normal settlement, two after `SIGTERM`, and
three after `SIGKILL` for reap, always capped by the one outer deadline.

The shared ten-second child/recovery slot has the same five/two/three normal/TERM/KILL-reap split.
It is spent once: on the active non-create child when cleanup first latches, or, only after the
15-second create slice ends with neither response nor event custody and no other non-watcher child
live, on the one exact-name recovery inspect. A hung recovery therefore cannot consume any of the
80-second two-ID allocation or displace later census, watcher, socket, path or scheduling work.

Cleanup preserves the active operation, exact ID, removal-attempt number and any completely parsed
result when it latches. Settling an already-active attempt-1 removal in the shared slot advances to
its mandatory first absence probe; it never restarts attempt 1. Settling the first absence probe
releases custody on exact not-found or advances to attempt 2 on present/ambiguous. Settling attempt
2 advances only to the mandatory final absence probe, and settling that final probe either releases
custody on exact not-found or fails cleanup. The same carry-forward rule applies when the child
settles normally during the latch transition. No completed result is discarded, no state regresses,
and the remaining per-ID allocation starts at the next state, so a signal during normal cleanup
cannot authorize a third removal or repeat an already-completed slot.
The same monotone cleanup cursor records preliminary census, CLOSE sent, watcher EOF/reap, final-ID
settlement, final census/socket check, path-helper launch/completion and parent absence check.
Latching during one of those children spends the shared slot settling that exact operation and then
continues at its successor; it never resends CLOSE, restarts a census already completed, relaunches
the production path helper or discards a parsed result. An ambiguous/hung nonrepeatable operation
marks cleanup failed while later independently safe absence/settlement steps still run within their
remaining fixed slots.

After every identity known before census launch has reached exact absence, the wrapper spends the
dedicated preliminary-census ten-second slot on one exact-label census while it continues draining
the event pipe. Empty output passes. A nonempty output may be deferred only when every listed ID is
the same one full ID supplied by the sole matching event after census launch; custody comes only
from that event, and every other nonempty result latches cleanup uncertainty. It then has ten
seconds to send CLOSE and await socket/ready/event EOF plus child reap: five seconds for graceful
closure, three after `SIGTERM` and two after cgroup `SIGKILL`. The helper is an owned guardian cgroup under
the same deadline; early EOF, disconnect, framing overflow, header hang or failure to settle
refuses. A sole final event emitted before EOF joins the at-most-two-ID union and is processed from
the still-reserved per-ID slots after watcher reap; an already-processed duplicate ID consumes no
new slot, while a second matching event refuses as cleanup-uncertain. Only after every such final ID
has reached exact absence does the wrapper spend ten seconds on the one final empty exact-label
census and socket device/inode revalidation while the private Docker config still exists. A
nonempty final census without corresponding cleanup custody is terminally cleanup-uncertain and
does not authorize label- or name-based deletion. The path helper then has 15 seconds to
restore verified directory owner-write bits, remove the source/vendor/toolchain/control/config/
ledger/record tree and invocation directory, sync its fixed parent and confirm every tracked
pathname absent: at most four seconds normal work, three after `SIGTERM`, three after `SIGKILL` for
reap, and five for the parent's exact final `lstat` absence check. Ten seconds remain only as
scheduling reserve. No inner phase receives a fresh cleanup deadline. Only the interruption
supervisor owns the disjoint post-reap acceptance interval and its custody slot described above.

From successful invocation-directory creation onward, one outer `try/finally` latches this cleanup
path for every normal success, ordinary nonzero exit, validation refusal, setup exception, deadline
and caught signal. Every post-create outcome removes and absence-checks the unique union of exact
response/event/name IDs. The original success or refusal is emitted only after child reap, container absence
watcher settlement and pathname absence are all confirmed; cleanup failure replaces any pending success.
Path removal runs in a separate asynchronous owned guardian cgroup through the fixed
`scripts/path-cleanup-helper.mjs` descriptor protocol above. It accepts only the fixed parent token,
invocation value, captured directory device/inode and cleanup-state enum needed to reconstruct and
authenticate the one directory. Parent and child each revalidate the literal system-temp parent,
fixed prefix, no-symlink ancestry, mode `0700`, invoking uid/gid and the state-appropriate record
rule.
Its complete 15-second allocation uses the exact four/three/three/five split above. No glob,
environment-selected root or synchronous recursive removal
is allowed.

A deadline, image mismatch, ambiguous creation, child-reap failure, cleanup failure or unconfirmed
container/pathname absence is a fixed nonzero refusal and can never emit proof success. Abrupt host
loss or uncatchable `SIGKILL` is not claimed recoverable by this source wrapper; any residue is
outside the repository and no interrupted invocation has a success result. Interruption tests cover
the three create-response cuts, delayed daemon acceptance after an empty inventory, ID-less mutation
uncertainty, normal success, every setup/refusal checkpoint, implicit-pull refusal, first plus
repeated signals, event-header hang/disconnect/overflow/close hang, and hung
pull/fetch/proof/list/inspect/remove/path-cleanup children, and require container absence whenever
exact container cleanup custody exists. A deliberately hung path helper must yield the fixed
cleanup-failed result after TERM/KILL/reap; the test harness then reruns the same fixed helper with
the unchanged authenticated directory identity solely as teardown and requires pathname absence
before the test returns. That teardown cannot convert the production refusal to success. Unrelated
ambient CI is not an input to a WP-201
proof case.

A separately authorized external proof additionally requires committed, independently reviewed
discovery evidence, an inert pre-staged candidate and a final executable policy whose one-way
signed manifest pins that exact ignored adapter. It then requires:

- an exact disposable-target authorization and expiry;
- attended fixed official asset acquisition into root-owned descriptors;
- exact target-scoped credentials with no fallback;
- measured official runtime and both preparation phase graphs;
- enforced gateway-only egress and raw-secret nonexposure;
- lossless gateway/session bindings and observer census;
- exact 41-file fetch, 46-file workdir and five-item dry-run evidence;
- byte-identical target postflight; and
- zero live resource residue and zero mutation.

The external proof prints only:

```text
openspell disposable preparation proof: history=41 dry-run=5 write=0 sessions=0 residue=0
```

WP-201 source can merge without external authorization, but WP-201 is not complete as a real
disposable proof and WP-202 remains blocked until that external evidence passes.

## Mandatory negative proofs

- Credential A against target B is provider-denied and no production target is contacted.
- Mixed project reference, fingerprint, API identity, TLS host or database identity refuses.
- Broad, expired, replayed, copied, cross-operation or cross-phase credential/lease refuses.
- Authorization expiry at every phase/effect boundary enters cleanup-only; realtime rollback cannot
  extend the monotonic authorization deadline.
- Host/SNI/DNS/IP/CNAME mismatch, rebinding, redirect, proxy and private-address bypasses refuse.
- Hostile CLI attempts at control mutation and database DDL/DML are denied and observer state is
  identical.
- Raw secret canaries are absent from CLI argv/env/fds, `/proc`, core, files, output, logs and
  evidence.
- Untagged, truncated, duplicate, pooled, reused or surviving database sessions refuse.
- Changing or clearing `application_name` never hides the immutable login/PID/backend-start census;
  a mismatch observed at either sample refuses, without claiming lossless transient-tag auditing.
- Runtime/acquisition mutation and every unexpected exec or dependency refuse.
- Substitution of any helper, root custodian, credential broker, gateway, observer, adapter binary or runtime root
  refuses before network/secret release even when the source revision matches.
- Discovery evidence cannot satisfy final executable policy or preparation success.
- History and dry-run count, byte, order, output, exit and misleading-success adversaries refuse.
- Every journal sync, credential, network, process, gateway, observer and response cut refuses or
  remains recovery-only without retry.
- Static inventories prove no reachable WP-201 apply phase/opcode/argv or write authority, generic
  exec/network/SQL surface, production credential source, deployment path, service, application
  import or live ordinary-CI trigger. Lexical v1 apply schemas in private dependencies do not count
  as reachable capability and compile-fail tests prove they cannot cross the WP-201 bridges.

## No-go gates

Stop WP-201 and keep WP-202 blocked if:

- exact provider-side project scope is unavailable or needs a broad fallback;
- the exact CLI cannot work through credential-translating gateways;
- dry-run requires a write-capable role or performs any hosted mutation;
- any raw hosted credential must enter the CLI cell;
- target identity rests on DNS, a label or self-assertion alone;
- exact host/method/path or one-to-one database binding cannot be enforced;
- target traffic can bypass the gateway;
- the reviewed discovery policy/evidence, inert candidate review or final executable policy is
  absent, or any adapter activation/execution capability predates the final policy;
- official source/runtime relies on host paths, mutable artifacts or unreviewed dependencies;
- a phase has an unexpected exec or untagged connection;
- cleanup, terminality, session absence or target no-change is uncertain; or
- code claims final all-phase provenance before WP-202.

## Verification and handoff

Source acceptance requires pinned Rust format/check/clippy/rustdoc/test across all three crates and
feature combinations, TypeScript boundary tests,
exact dependency/module/reverse-dependency inventories, deterministic golden comparison, full
repository typecheck/lint/test/hygiene and `git diff --check`. High correctness review and two
Extra-High credential/egress/crash reviews must inspect the exact implementation commit.
It also proves ordinary CI has no external adapter and that no policy fixture can authorize a live
route. The policy addenda, adapter and external proof are later reviewed commits in WP-201, not an
implicit side effect of merging the source core.

WP-202 receives only the closed non-authorizing observation schema and the reviewed composition
interfaces. It receives no live custody or permission. WP-203 still owns deployable artifacts and
services; WP-204 owns separately authorized production preparation; WP-205 owns the exact production
database apply.
