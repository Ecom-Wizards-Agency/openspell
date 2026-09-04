# WP-201 architecture: disposable hosted preparation without apply

Status: selected for implementation on 2026-09-04.

Base: `origin/main` at `51a56b392ab524dc140e343fe1dc87b58e17c42f`.

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
  scripts/docker-event-helper.mjs
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
  src/model_tests.rs
  src/adversarial_tests.rs
  src/boundary.test.ts
  src/composition.test.ts
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

Before implementing the container wrapper, amend this architecture and the brief to freeze the
invocation-directory prefix, Docker label keys and role values, acquisition network, container
mount destinations, vendor-ledger byte framing, event-helper descriptor/control protocol, pinned
proof-image digest and per-manifest Cargo command matrix. The constraints below are mandatory but
do not yet supply those concrete values. Independently review the exact amendment hash before code.

WP-201 test behavior uses only synthetic assets, fake gateways, fake credentials and disposable
local files. It opens no external network and contacts no Supabase project, browser, database,
service or Amazon endpoint. The repository's ambient CI may provision PostgreSQL for unrelated
packages. The coordinator package owns its Rust wrapper and routes every cross-crate bridge-success
test through the reviewed root proof container even when the pinned toolchain is installed locally.
Feature compile checks and pure/refusal tests may use the prior crates' existing entry points; merely
building `wp201-internal` does not satisfy a bridge-success row. The proof container runs as uid/gid
zero by omitting `--user`, uses the pinned local image ID as described below, has `--network none`,
`--read-only`, `--cap-drop ALL` and `--security-opt no-new-privileges`, has no writable host mount
or Docker socket, and creates all ownership-sensitive fixtures under private tmpfs mounts. Its
complete writable mount allowlist is `CARGO_HOME`, `CARGO_TARGET_DIR`/`OUT_DIR`, `TMPDIR`/test
fixtures and a minimal home, all separate tmpfs mounts; the image root and toolchain remain
read-only. The no-feature root-authority checks retain their pinned local fast path, but they do not
satisfy a bridge-success row.

Before a cold container proof, the wrapper creates one fresh mode-`0700` invocation directory owned
by the invoking uid/gid in a resolved system temporary directory outside the workspace. It first
inspects the exact digest reference without pull. If absent, a separately bounded setup command may
pull only that digest; the resulting shared image/layers are intentionally retained as an immutable
cache, not treated as proof output. The wrapper then inspects the digest reference, requires its
repo-digest set to contain the exact configured digest and captures its full `sha256:<64-hex>` local
image ID once. Every later `docker create` uses only that captured ID plus `--pull never`; neither
the acquisition nor proof create may perform an implicit pull.

A first acquisition container runs as the invoking uid/gid and may use only the package network, a
read-only source mount, that invocation directory and a fresh Cargo home. It also uses `--read-only`,
`--cap-drop ALL` and `--security-opt no-new-privileges`. It runs exactly `cargo fetch --locked`
followed by `cargo vendor --locked --versioned-dirs`; it may not compile, run a build script or
execute a proof. Every non-workspace/non-path lock entry must be a checksummed registry source, and
the boundary test separately pins the exact local path-package set. After acquisition, the wrapper
requires every output to be owned by its invoking uid/gid, rejects links and special files, and
normalizes the vendor tree to mode `0500` directories and mode `0400` regular files; source execute
bits confer no authority because Cargo compiles build scripts into the separate target tmpfs. It
then validates every Cargo `.cargo-checksum.json` mapping and records a canonical sorted
path/size/SHA-256 ledger over `Cargo.lock` and every vendored regular file. The ledger is a
mode-`0400` regular file. The networked acquisition operation is not proof evidence. Its ledger-
bound vendor bytes are explicit build inputs.

The separate root proof container receives the source, vendor tree and ledger as read-only bind
mounts. Before Cargo starts, it independently recomputes and matches the ledger. It sets
`CARGO_NET_OFFLINE=true`, replaces crates.io with that exact directory source, and uses writable
tmpfs only for `CARGO_HOME`, `CARGO_TARGET_DIR`, `TMPDIR` and test fixtures; procfs is its own
container procfs. The vendor mount remains immutable during dependency expansion, proc-macro/build-
script compilation and proof execution. No fetched cache is copied into writable storage. Boundary
tests assert the exact image digest/ID and `--pull never`, exact commands and path-package set,
acquisition/proof separation, root proof identity, `--read-only`, capability/no-new-privileges
restrictions, `--network none`, offline replacement, read-only source/vendor/ledger mounts, writable-
tmpfs allowlist, independent ledger match and absence of any proof command from the acquisition
container.

Each container is created, then started, as two operations rather than through `docker run`. Before
create, the wrapper generates a 32-byte random invocation value, durably stores it in its private
directory and requires an exact Docker list by that immutable invocation/role label to be empty.
The wrapper refuses `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_TLS_VERIFY` or `DOCKER_CERT_PATH`,
requires the Docker context name `default`, requires its endpoint to be exactly
`unix:///var/run/docker.sock`, records that root-owned mode-`0660` Unix socket's device/inode and
revalidates the socket before every client operation and after watcher closure.
Every Docker client argv places `--host unix:///var/run/docker.sock` immediately after the resolved
Docker executable, so context mutation cannot retarget list, pull, create, start, inspect or remove;
boundary tests reject any client invocation without that exact endpoint. Before sending
create it spawns the owned `scripts/docker-event-helper.mjs`, which connects directly to that Unix
socket and requests the fixed Engine API `/v1.47/events` stream with only `type=container`,
`event=create` and both exact invocation/role label filters. The helper caps headers at 8,192 bytes,
event framing at 65,536 bytes total and accepts at most one matching Engine-event JSON frame with
one full 64-hex actor ID. Engine events are external protocol frames, explicitly not WP-201
canonical-record JSON. The duplicate-key-rejecting decoder ignores object key order but allows only
the top-level keys `status`, `id`, `from`, `Type`, `Action`, `Actor`, `scope`, `time` and `timeNano`;
`status`, `id` and `from` may be absent, while all other keys are required. `Type`, `Action` and
`scope` must be `container`, `create` and `local`; optional `status` must be `create`; optional `id`
must equal `Actor.ID`; optional `from` is a bounded string. `Actor` has exactly `ID` and `Attributes`;
its ID is full lowercase 64-hex and its string-to-string attribute map has at most 32 entries and
must contain the two exact requested labels; `from` plus every attribute key/value is at most 4,096
UTF-8 bytes. `time` is a nonnegative JSON safe integer. Because real Engine nanosecond timestamps
exceed JavaScript's safe range, the duplicate-aware raw decoder accepts `timeNano` only as a
canonical unsigned one-to-19-digit JSON integer token without converting it through `Number`.
Neither time is used as identity or deadline evidence. Arbitrary HTTP chunk splits are accepted, but the decoded
event must be one JSON object followed by LF with no trailing bytes; duplicate, unknown, missing,
non-string, over-limit or second frames refuse. A fixed real-shaped Engine API fixture covers this
decoder. Only after parsing an HTTP 200 response and complete headers does it write the
fixed frame `openspell.wp201.docker-event-ready.v1\n` to its private ready pipe; its separate event
pipe carries only the bounded validated ID. The wrapper must receive that exact ready frame before
create. This is the independent same-daemon settlement channel. The create request contains those
labels. A valid create response is exactly one full 64-hex
container ID. A caught wrapper signal is latched but may not sever an in-flight mutation client
before that client returns its response-bound ID; no later start is permitted after the latch. On
response loss or a malformed response, the wrapper boundedly continues the already-established
event stream after the client is reaped. An exact create event supplies its full daemon-issued ID;
the wrapper cross-checks that ID against repeated exact-label inventories. It never treats a
momentarily empty query as proof of nonoccurrence. If neither the create response nor the event
stream supplies an ID by the end of the 15-second create settle/TERM/KILL-reap slice, capped by the
common hard deadline, the result is permanently cleanup-uncertain and
cannot emit success. Label listings alone are absence diagnostics only. When an exact response- or
event-bound ID exists, `docker inspect` must match the
immutable invocation/role labels, captured image ID, exact argv, network/security/capability/mount
configuration and expected start count before deletion. Cleanup and all later operations address
only that verified immutable full ID, never a name or label. A mismatch or multiple diagnostic
candidates is likewise cleanup-uncertain with no deletion authority. Deterministic test-only shims
write the exact ID from the real create response into a mode-`0600` side channel before holding that
response at the after-acceptance and before-delivery cuts, transferring cleanup custody to the
interruption harness. The before-acceptance cut proves the create request was not sent. Tests never
claim zero residue after an ID-less mutation timeout; they require a cleanup-uncertain refusal. A
delayed-acceptance cut makes an initial inventory return empty, then publishes the daemon event and
container; the wrapper must capture, validate, remove and prove absent that exact late ID.

The wrapper opens and validates `/proc/uptime` on procfs and derives one absolute Linux boot-time
deadline per image-acquisition, dependency-acquisition and proof operation. Active budgets are 300
seconds for either acquisition and 900 seconds for proof; each hard deadline adds exactly 55 seconds
of cleanup reserve. Every child, including pull, create, start, list, inspect and remove, is an
asynchronous owned process group capped to the remaining absolute deadline. At active-budget expiry
or the first caught `SIGINT`, `SIGTERM` or `SIGHUP`, cleanup is latched and later signals cannot
reenter or bypass it. A Docker create client is first allowed at most five seconds to settle so its
response-bound immutable ID is not discarded; it then receives `SIGTERM`, at most five seconds,
`SIGKILL`, and at most five more seconds to reap. Other active children begin with that same five-
second TERM interval and five-second KILL/reap interval. An ID-less create after forced settlement
is classified cleanup-uncertain, never absent. For an exact held ID, the wrapper has at most ten further
seconds, capped by the same absolute deadline, for verified-ID force removal and an exact absent
inspection; those Docker clients use the same owned-group TERM/KILL/reap rule. It then has ten
seconds to close the event helper's control pipe and await socket/ready/event EOF plus child reap:
five seconds for graceful closure, three after `SIGTERM` and two after `SIGKILL`. The helper is an
owned process group under the same deadline; early EOF, disconnect, framing overflow, header hang or
failure to settle refuses. It has at most 15
further seconds for target/test tmpfs lifetimes to end and to remove the Cargo home, vendor tree,
ledger, label record and invocation directory, then confirms every tracked pathname absent. Five
seconds remain only as scheduling reserve. No phase receives a fresh cleanup deadline.

From successful invocation-directory creation onward, one outer `try/finally` latches this cleanup
path for every normal success, ordinary nonzero exit, validation refusal, setup exception, deadline
and caught signal. Every post-create outcome with an exact response/event ID removes and absence-
checks that ID. The original success or refusal is emitted only after child reap, container absence
watcher settlement and pathname absence are all confirmed; cleanup failure replaces any pending success.
Path removal runs in a separate asynchronous owned process group by reinvoking the pinned Node
executable in a private cleanup mode. That helper accepts only the one fully resolved invocation
path already recorded in memory, after the parent and child each revalidate its system-temp parent,
fixed prefix, no-symlink ancestry, mode `0700`, invoking uid/gid and matching durable label record.
Its complete 15-second allocation includes at most five seconds of normal work, five after
`SIGTERM`, and five after `SIGKILL` for reap; the parent then performs the final `lstat`-absence check
within that same allocation. No glob, environment-selected root or synchronous recursive removal
is allowed.

A deadline, image mismatch, ambiguous creation, child-reap failure, cleanup failure or unconfirmed
container/pathname absence is a fixed nonzero refusal and can never emit proof success. Abrupt host
loss or uncatchable `SIGKILL` is not claimed recoverable by this source wrapper; any residue is
outside the repository and no interrupted invocation has a success result. Interruption tests cover
the three create-response cuts, delayed daemon acceptance after an empty inventory, ID-less mutation
uncertainty, normal success, every setup/refusal checkpoint, implicit-pull refusal, first plus
repeated signals, event-header hang/disconnect/overflow/close hang, and hung
pull/fetch/proof/list/inspect/remove/path-cleanup children, and require
absence whenever exact cleanup custody exists. Unrelated ambient CI is not an input to a WP-201
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
