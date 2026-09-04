//! Synthetic installed-policy, bootstrap, installation authorization, and registry generation one.

use std::ffi::CString;
use std::os::fd::OwnedFd;

use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use nix::fcntl::{FcntlArg, FdFlag, OFlag, SealFlag, fcntl};
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, ResolveFlags, StatxFlags, fstat, fstatfs, fsync, openat2,
    readlinkat, statx,
};
use rustix::time::{ClockId, clock_gettime};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use time::OffsetDateTime;
use zeroize::Zeroizing;

use crate::canonical::{is_lower_hex, validate_millisecond_timestamp};
use crate::journal::storage::{
    Owner, RegistryFinalPublicationError, acquire_shared_ofd_lock, open_existing, open_regular,
    publish, publish_registry_final, read_exact_file, read_names, require_names,
    verify_entry_matches_fd, verify_metadata,
};
use crate::preparation_v2::EmptyPreparationJournal;
use crate::super_lock::{
    ExpectedOwner, HeldStateRoot, RootOwner, create_directory, domain_digest,
    open_directory_any_links, verify_input_directory_descriptor,
};

const POLICY_BYTES: &[u8] = include_bytes!("preparation-policy-v1.golden.json");
const POLICY_SHA256: &str = "692216120478fce4caa82e569767ec872b36ec7fccbf4c9430eb7f11e433fcdb";
const BOOTSTRAP_FORMAT: &[u8] = b"openspell.synthetic-preparation-proof-bootstrap.v1\n";
const BOOTSTRAP_GENESIS: &str = "8a8a886ffc13da0bbb70e73d66268c16ad36ba5a23b00bb7e5bb911e01a10345";
const REGISTRY_FORMAT: &[u8] = b"openspell.hosted-migration-authority-registry.v1\n";
const REGISTRY_GENESIS: &str = "dfe1ba8e9380db530e4d8847e8169cf919455cb25df9734bdab34def9ba8f0c7";
const CLOCK_POLICY_SHA256: &str =
    "bb4c27585d7712adb4a8d5c0973a3123a42a67995964b0510ffdb21d9e1cadb2";
const PROCFS_MAGIC: u64 = 0x0000_9fa0;
const TMPFS_MAGIC: u64 = 0x0102_1994;
const MAX_RECORD: usize = 16_384;
const REGISTRY_INVENTORY_DOMAIN: &[u8] =
    b"openspell.hosted-migration-authority-registry-inventory.v1\n";
const MAX_REGISTRY_TRANSITIONS: usize = 2;
const MAX_REGISTRY_RECORDS: usize = 3;
const MAX_REGISTRY_SIGNATURES: usize = 3;
const MAX_REGISTRY_TOTAL_BYTES: usize = 262_144;

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK);
const DIRECTORY_READ_FLAGS: OFlags = READ_FLAGS.union(OFlags::DIRECTORY);
const SYS_RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS);
const REQUIRED_STATX: StatxFlags = StatxFlags::BASIC_STATS.union(StatxFlags::MNT_ID);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledPolicyWire {
    schema_version: String,
    policy_class: String,
    source_revision: String,
    proof_bootstrap_verifier_identity_sha256: String,
    proof_bootstrap_manifest_sha256: String,
    proof_bootstrap_activation_public_key_hex: String,
    root_issuer_public_key_hex: String,
    runtime_custodian_public_key_hex: String,
    credential_broker_signer_public_key_hex: String,
    credential_broker_request_verifier_public_key_hex: String,
    credential_broker_request_domain_sha256: String,
    credential_broker_runtime_identity_sha256: String,
    credential_broker_protocol_sha256: String,
    credential_broker_peer_policy_sha256: String,
    credential_store_resource_map_sha256: String,
    credential_store_route_policy_sha256: String,
    credential_store_dns_policy_sha256: String,
    credential_store_tls_server_policy_sha256: String,
    credential_store_protocol_sha256: String,
    trusted_clock_provider_sha256: String,
    entropy_provider_sha256: String,
    source_policy_sha256: String,
    runtime_policy_sha256: String,
    privileged_executable_policy_sha256: String,
    privileged_executable_policy_generation: u64,
    target_class: String,
    external_capability: bool,
    live_adapter_allowed: bool,
}

pub(crate) struct InstalledPolicy {
    pub(crate) source_revision: String,
    pub(crate) bootstrap_verifier_sha256: String,
    pub(crate) bootstrap_manifest_sha256: String,
    pub(crate) bootstrap_key: [u8; 32],
    pub(crate) root_issuer_key: [u8; 32],
    pub(crate) registry_key: [u8; 32],
    pub(crate) executable_policy_sha256: String,
}

pub(crate) fn inspect_policy(fd: OwnedFd, expected: ExpectedOwner) -> Result<InstalledPolicy, ()> {
    let stat = fstat(&fd).map_err(|_| ())?;
    let owner = Owner {
        uid: expected.uid(),
        gid: expected.gid(),
        dev: stat.st_dev,
    };
    verify_metadata(&stat, owner, FileType::RegularFile, 0o600, 1)?;
    if stat.st_size != POLICY_BYTES.len() as i64 || !has_cloexec(&fd)? || !is_read_only(&fd)? {
        return Err(());
    }
    let bytes = pread_exact(&fd, POLICY_BYTES.len())?;
    if bytes != POLICY_BYTES || hex::encode(Sha256::digest(&bytes)) != POLICY_SHA256 {
        return Err(());
    }
    let wire: InstalledPolicyWire = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if wire.schema_version != "openspell.preparation-installed-root-policy.v1"
        || wire.policy_class != "synthetic_deny_live"
        || wire.source_revision != "0000000000000000000000000000000000000000"
        || wire.privileged_executable_policy_generation != 0
        || wire.target_class != "synthetic_only"
        || wire.external_capability
        || wire.live_adapter_allowed
        || wire.trusted_clock_provider_sha256 != CLOCK_POLICY_SHA256
    {
        return Err(());
    }
    for digest in [
        &wire.proof_bootstrap_verifier_identity_sha256,
        &wire.proof_bootstrap_manifest_sha256,
        &wire.credential_broker_request_domain_sha256,
        &wire.credential_broker_runtime_identity_sha256,
        &wire.credential_broker_protocol_sha256,
        &wire.credential_broker_peer_policy_sha256,
        &wire.credential_store_resource_map_sha256,
        &wire.credential_store_route_policy_sha256,
        &wire.credential_store_dns_policy_sha256,
        &wire.credential_store_tls_server_policy_sha256,
        &wire.credential_store_protocol_sha256,
        &wire.entropy_provider_sha256,
        &wire.source_policy_sha256,
        &wire.runtime_policy_sha256,
        &wire.privileged_executable_policy_sha256,
    ] {
        if !is_lower_hex(digest, 32) {
            return Err(());
        }
    }
    for key in [
        &wire.proof_bootstrap_activation_public_key_hex,
        &wire.root_issuer_public_key_hex,
        &wire.runtime_custodian_public_key_hex,
        &wire.credential_broker_signer_public_key_hex,
        &wire.credential_broker_request_verifier_public_key_hex,
    ] {
        if !is_lower_hex(key, 32) {
            return Err(());
        }
    }
    Ok(InstalledPolicy {
        source_revision: wire.source_revision,
        bootstrap_verifier_sha256: wire.proof_bootstrap_verifier_identity_sha256,
        bootstrap_manifest_sha256: wire.proof_bootstrap_manifest_sha256,
        bootstrap_key: decode_key(&wire.proof_bootstrap_activation_public_key_hex)?,
        root_issuer_key: decode_key(&wire.root_issuer_public_key_hex)?,
        registry_key: decode_key(&wire.credential_broker_request_verifier_public_key_hex)?,
        executable_policy_sha256: wire.privileged_executable_policy_sha256,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BootstrapRecord {
    schema_version: String,
    registry_generation: u64,
    previous_registry_record_sha256: String,
    current_policy_sha256: String,
    current_manifest_sha256: String,
    bootstrap_verifier_identity_sha256: String,
    bootstrap_lock_identity_sha256: String,
    source_revision: String,
    activated_at: String,
    issuer_public_key_sha256: String,
    detached_signature_sha256: String,
}

pub(crate) struct BootstrapLease {
    pub(crate) policy: InstalledPolicy,
    record: OwnedFd,
    signature: OwnedFd,
    format: OwnedFd,
    current: OwnedFd,
    records: OwnedFd,
    signatures: OwnedFd,
    objects: OwnedFd,
    pub(crate) root: OwnedFd,
    pub(crate) registry_sha256: String,
    pub(crate) lock_identity_sha256: String,
    uid: u32,
    gid: u32,
    pub(crate) lock: OwnedFd,
}

pub(crate) fn inspect_bootstrap(
    policy: InstalledPolicy,
    root: OwnedFd,
    expected: ExpectedOwner,
) -> Result<BootstrapLease, ()> {
    verify_input_directory_descriptor(&root)?;
    let root_stat = fstat(&root).map_err(|_| ())?;
    let owner = Owner {
        uid: expected.uid(),
        gid: expected.gid(),
        dev: root_stat.st_dev,
    };
    verify_metadata(&root_stat, owner, FileType::Directory, 0o700, 3)?;
    let lock = open_existing(
        &root,
        c"LOCK",
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
    )?;
    acquire_shared_ofd_lock(&lock)?;
    let lock_stat = verify_entry_matches_fd(
        &root,
        c"LOCK",
        &lock,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if lock_stat.st_size != 0 {
        return Err(());
    }
    require_names(&root, &["FORMAT", "LOCK", "CURRENT", "objects"])?;
    let format = open_regular(&root, c"FORMAT", owner, BOOTSTRAP_FORMAT.len(), false)?;
    if read_exact_file(&format, BOOTSTRAP_FORMAT.len())? != BOOTSTRAP_FORMAT {
        return Err(());
    }
    let lock_identity_sha256 = bootstrap_lock_identity(&lock, expected.uid(), expected.gid())?;
    let current = open_regular(&root, c"CURRENT", owner, 65, false)?;
    let current_bytes = read_exact_file(&current, 65)?;
    if current_bytes[64] != b'\n' {
        return Err(());
    }
    let registry_sha256 = std::str::from_utf8(&current_bytes[..64]).map_err(|_| ())?;
    if !is_lower_hex(registry_sha256, 32) {
        return Err(());
    }
    let objects = open_directory_any_links(
        &root,
        "objects",
        RootOwner {
            uid: expected.uid(),
            gid: expected.gid(),
            dev: owner.dev,
        },
    )?;
    require_names(&objects, &["records", "signatures"])?;
    let records = open_directory_any_links(
        &objects,
        "records",
        RootOwner {
            uid: expected.uid(),
            gid: expected.gid(),
            dev: owner.dev,
        },
    )?;
    let signatures = open_directory_any_links(
        &objects,
        "signatures",
        RootOwner {
            uid: expected.uid(),
            gid: expected.gid(),
            dev: owner.dev,
        },
    )?;
    let record_names = read_names(&records, 1)?;
    let signature_names = read_names(&signatures, 1)?;
    if record_names != [registry_sha256] || signature_names.len() != 1 {
        return Err(());
    }
    let record_name = CString::new(registry_sha256).map_err(|_| ())?;
    let record = open_dynamic_record(&records, &record_name, owner)?;
    let record_size = usize::try_from(fstat(&record).map_err(|_| ())?.st_size).map_err(|_| ())?;
    let record_bytes = read_exact_file(&record, record_size)?;
    if hex::encode(Sha256::digest(&record_bytes)) != registry_sha256 {
        return Err(());
    }
    let parsed: BootstrapRecord = decode_exact(&record_bytes, encode_bootstrap)?;
    let signature_name = signature_names.first().ok_or(())?;
    if signature_name != &parsed.detached_signature_sha256 {
        return Err(());
    }
    let signature_c = CString::new(signature_name.as_bytes()).map_err(|_| ())?;
    let signature = open_regular(&signatures, &signature_c, owner, 64, false)?;
    let signature_bytes: [u8; 64] = read_exact_file(&signature, 64)?
        .try_into()
        .map_err(|_| ())?;
    verify_bootstrap(&parsed, &signature_bytes, &policy, &lock_identity_sha256)?;
    Ok(BootstrapLease {
        policy,
        root,
        lock,
        format,
        current,
        objects,
        record,
        signature,
        records,
        signatures,
        registry_sha256: registry_sha256.to_owned(),
        lock_identity_sha256,
        uid: expected.uid(),
        gid: expected.gid(),
    })
}

fn verify_bootstrap(
    record: &BootstrapRecord,
    signature: &[u8; 64],
    policy: &InstalledPolicy,
    lock_identity: &str,
) -> Result<(), ()> {
    if record.schema_version != "openspell.synthetic-preparation-proof-bootstrap-record.v1"
        || record.registry_generation != 0
        || record.previous_registry_record_sha256 != BOOTSTRAP_GENESIS
        || record.current_policy_sha256 != POLICY_SHA256
        || record.current_manifest_sha256 != policy.bootstrap_manifest_sha256
        || record.bootstrap_verifier_identity_sha256 != policy.bootstrap_verifier_sha256
        || record.bootstrap_lock_identity_sha256 != lock_identity
        || record.source_revision != policy.source_revision
        || record.issuer_public_key_sha256 != sha256_hex(&policy.bootstrap_key)
        || record.detached_signature_sha256 != sha256_hex(signature)
        || validate_millisecond_timestamp(&record.activated_at).is_err()
    {
        return Err(());
    }
    verify_signature(
        "openspell.synthetic-preparation-proof-bootstrap-signature.v1",
        &encode_bootstrap_unsigned(record),
        signature,
        &policy.bootstrap_key,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstallationAuthorization {
    schema_version: String,
    installation_authorization_nonce: String,
    source_revision: String,
    proof_bootstrap_registry_sha256: String,
    proof_bootstrap_verifier_identity_sha256: String,
    proof_bootstrap_manifest_sha256: String,
    proof_bootstrap_lock_identity_sha256: String,
    bound_state_root_identity_sha256: String,
    preparation_policy_sha256: String,
    privileged_executable_policy_sha256: String,
    privileged_executable_policy_generation: u64,
    registry_signer_public_key_sha256: String,
    trusted_clock_provider_sha256: String,
    active_format: String,
    active_journal_name: String,
    target_class: String,
    external_capability: bool,
    live_adapter_allowed: bool,
    maximum_duration_seconds: u64,
    issued_at: String,
    expires_at: String,
    authenticated_operator_identity_sha256: String,
    os_authentication_session_sha256: String,
    authenticated_at: String,
    issuer_public_key_sha256: String,
    detached_signature_sha256: String,
}

pub(crate) fn verify_installation_authorization(
    bytes: &[u8],
    signature: &[u8; 64],
    lease: &BootstrapLease,
    root_identity: &str,
    registry_key: &[u8; 32],
    now: OffsetDateTime,
) -> Result<InstallationAuthorization, ()> {
    let auth: InstallationAuthorization = decode_exact(bytes, encode_installation)?;
    validate_installation_bindings(&auth, signature, lease, root_identity, registry_key)?;
    validate_installation_time_shape(&auth)?;
    let authenticated = validate_millisecond_timestamp(&auth.authenticated_at).map_err(|_| ())?;
    let issued = validate_millisecond_timestamp(&auth.issued_at).map_err(|_| ())?;
    let expires = validate_millisecond_timestamp(&auth.expires_at).map_err(|_| ())?;
    if authenticated > issued
        || issued > now
        || now > expires
        || issued - authenticated > time::Duration::seconds(60)
        || now - issued > time::Duration::seconds(30)
        || expires - issued <= time::Duration::ZERO
        || expires - issued > time::Duration::seconds(300)
    {
        return Err(());
    }
    verify_signature(
        "openspell.preparation-state-root-installation-authorization-signature.v1",
        &encode_installation_unsigned(&auth),
        signature,
        &lease.policy.root_issuer_key,
    )?;
    Ok(auth)
}

pub(crate) fn installation_expires_at(
    auth: &InstallationAuthorization,
) -> Result<OffsetDateTime, ()> {
    validate_millisecond_timestamp(&auth.expires_at).map_err(|_| ())
}

pub(crate) fn revalidate_bootstrap(lease: &BootstrapLease) -> Result<(), ()> {
    let stat = fstat(&lease.root).map_err(|_| ())?;
    let owner = Owner {
        uid: lease.uid,
        gid: lease.gid,
        dev: stat.st_dev,
    };
    verify_metadata(&stat, owner, FileType::Directory, 0o700, 3)?;
    require_names(&lease.root, &["FORMAT", "LOCK", "CURRENT", "objects"])?;
    require_names(&lease.objects, &["records", "signatures"])?;
    require_names(&lease.records, &[&lease.registry_sha256])?;
    let signature_bytes = read_exact_file(&lease.signature, 64)?;
    let signature_name_text = sha256_hex(&signature_bytes);
    require_names(&lease.signatures, &[&signature_name_text])?;
    verify_entry_matches_fd(
        &lease.root,
        c"FORMAT",
        &lease.format,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if read_exact_file(&lease.format, BOOTSTRAP_FORMAT.len())? != BOOTSTRAP_FORMAT {
        return Err(());
    }
    verify_entry_matches_fd(
        &lease.root,
        c"LOCK",
        &lease.lock,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    verify_entry_matches_fd(
        &lease.root,
        c"objects",
        &lease.objects,
        owner,
        FileType::Directory,
        0o700,
        4,
    )?;
    verify_entry_matches_fd(
        &lease.objects,
        c"records",
        &lease.records,
        owner,
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &lease.objects,
        c"signatures",
        &lease.signatures,
        owner,
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &lease.root,
        c"CURRENT",
        &lease.current,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    let record_name = CString::new(lease.registry_sha256.as_bytes()).map_err(|_| ())?;
    verify_entry_matches_fd(
        &lease.records,
        &record_name,
        &lease.record,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    let signature_name = CString::new(signature_name_text).map_err(|_| ())?;
    verify_entry_matches_fd(
        &lease.signatures,
        &signature_name,
        &lease.signature,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if read_exact_file(&lease.current, 65)? != format!("{}\n", lease.registry_sha256).as_bytes() {
        return Err(());
    }
    if bootstrap_lock_identity(&lease.lock, lease.uid, lease.gid)? != lease.lock_identity_sha256 {
        return Err(());
    }
    let record_size =
        usize::try_from(fstat(&lease.record).map_err(|_| ())?.st_size).map_err(|_| ())?;
    let record_bytes = read_exact_file(&lease.record, record_size)?;
    if sha256_hex(&record_bytes) != lease.registry_sha256 {
        return Err(());
    }
    let parsed: BootstrapRecord = decode_exact(&record_bytes, encode_bootstrap)?;
    let signature_bytes: [u8; 64] = signature_bytes.try_into().map_err(|_| ())?;
    verify_bootstrap(
        &parsed,
        &signature_bytes,
        &lease.policy,
        &lease.lock_identity_sha256,
    )?;
    Ok(())
}

fn validate_installation_bindings(
    auth: &InstallationAuthorization,
    signature: &[u8; 64],
    lease: &BootstrapLease,
    root_identity: &str,
    registry_key: &[u8; 32],
) -> Result<(), ()> {
    if auth.schema_version != "openspell.preparation-state-root-installation-authorization.v1"
        || !is_lower_hex(&auth.installation_authorization_nonce, 32)
        || auth.source_revision != lease.policy.source_revision
        || auth.proof_bootstrap_registry_sha256 != lease.registry_sha256
        || auth.proof_bootstrap_verifier_identity_sha256 != lease.policy.bootstrap_verifier_sha256
        || auth.proof_bootstrap_manifest_sha256 != lease.policy.bootstrap_manifest_sha256
        || auth.proof_bootstrap_lock_identity_sha256 != lease.lock_identity_sha256
        || auth.bound_state_root_identity_sha256 != root_identity
        || auth.preparation_policy_sha256 != POLICY_SHA256
        || auth.privileged_executable_policy_sha256 != lease.policy.executable_policy_sha256
        || auth.privileged_executable_policy_generation != 0
        || auth.registry_signer_public_key_sha256 != sha256_hex(registry_key)
        || auth.trusted_clock_provider_sha256 != CLOCK_POLICY_SHA256
        || auth.active_format != "preparation_v2"
        || auth.active_journal_name != "PREPARATION_JOURNAL_V2"
        || auth.target_class != "synthetic_only"
        || auth.external_capability
        || auth.live_adapter_allowed
        || auth.maximum_duration_seconds != 300
        || auth.issuer_public_key_sha256 != sha256_hex(&lease.policy.root_issuer_key)
        || auth.detached_signature_sha256 != sha256_hex(signature)
        || !is_lower_hex(&auth.authenticated_operator_identity_sha256, 32)
        || !is_lower_hex(&auth.os_authentication_session_sha256, 32)
    {
        return Err(());
    }
    Ok(())
}

fn validate_installation_time_shape(auth: &InstallationAuthorization) -> Result<(), ()> {
    let authenticated = validate_millisecond_timestamp(&auth.authenticated_at).map_err(|_| ())?;
    let issued = validate_millisecond_timestamp(&auth.issued_at).map_err(|_| ())?;
    let expires = validate_millisecond_timestamp(&auth.expires_at).map_err(|_| ())?;
    if authenticated > issued
        || issued >= expires
        || issued - authenticated > time::Duration::seconds(60)
        || expires - issued > time::Duration::seconds(300)
    {
        return Err(());
    }
    Ok(())
}

pub(crate) struct TrustedClockSample {
    pub(crate) realtime: OffsetDateTime,
    pub(crate) boottime_ns: i128,
    pub(crate) boot_id: String,
    path_identity: TrustedClockPathIdentity,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct TrustedClockPathIdentity {
    procfs: FileIdentity,
    sys: FileIdentity,
    boot_id: FileIdentity,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
    dev_major: u32,
    dev_minor: u32,
    inode: u64,
    mount_id: u64,
}

pub(crate) fn sample_clock(procfs: &OwnedFd) -> Result<TrustedClockSample, ()> {
    let procfs_identity = verify_procfs_root(procfs)?;
    let pid = rustix::process::getpid();
    let pid_text = pid.as_raw_nonzero().get().to_string();
    let self_target = readlinkat(procfs, "self", Vec::new()).map_err(|_| ())?;
    if self_target.to_bytes() != pid_text.as_bytes() || rustix::process::getpid() != pid {
        return Err(());
    }
    let (sys, sys_identity) = open_clock_sys(procfs)?;
    if sys_identity.mount_id == procfs_identity.mount_id {
        return Err(());
    }
    let (boot_id, boot_id_identity) = open_boot_id(&sys)?;
    let before_boot_id = pread_exact(&boot_id, 37)?;
    let offsets_path = format!("{pid_text}/timens_offsets");
    let before_offsets = read_proc_file(procfs, &offsets_path, 512)?;
    validate_boot_id(&before_boot_id)?;
    validate_zero_offsets(&before_offsets)?;
    let realtime_raw = clock_gettime(ClockId::Realtime);
    let boottime_raw = clock_gettime(ClockId::Boottime);
    let (reopened_sys, reopened_sys_identity) = open_clock_sys(procfs)?;
    let (reopened_boot_id, reopened_boot_id_identity) = open_boot_id(&reopened_sys)?;
    let after_boot_id = pread_exact(&reopened_boot_id, 37)?;
    let after_offsets = read_proc_file(procfs, &offsets_path, 512)?;
    if before_boot_id != after_boot_id
        || before_offsets != after_offsets
        || verify_procfs_root(procfs)? != procfs_identity
        || reopened_sys_identity != sys_identity
        || reopened_boot_id_identity != boot_id_identity
    {
        return Err(());
    }
    let realtime = OffsetDateTime::from_unix_timestamp(realtime_raw.tv_sec).map_err(|_| ())?
        + time::Duration::nanoseconds(realtime_raw.tv_nsec);
    let boottime_ns = i128::from(boottime_raw.tv_sec)
        .checked_mul(1_000_000_000)
        .and_then(|value| value.checked_add(i128::from(boottime_raw.tv_nsec)))
        .ok_or(())?;
    if boottime_ns < 0 {
        return Err(());
    }
    Ok(TrustedClockSample {
        realtime,
        boottime_ns,
        boot_id: String::from_utf8(before_boot_id[..36].to_vec()).map_err(|_| ())?,
        path_identity: TrustedClockPathIdentity {
            procfs: procfs_identity,
            sys: sys_identity,
            boot_id: boot_id_identity,
        },
    })
}

pub(crate) fn same_clock_path(left: &TrustedClockSample, right: &TrustedClockSample) -> bool {
    left.path_identity == right.path_identity
}

fn verify_procfs_root(procfs: &OwnedFd) -> Result<FileIdentity, ()> {
    let stat = fstat(procfs).map_err(|_| ())?;
    let owner = Owner {
        uid: 0,
        gid: 0,
        dev: stat.st_dev,
    };
    verify_metadata(&stat, owner, FileType::Directory, 0o555, stat.st_nlink)?;
    if stat.st_size != 0
        || fstatfs(procfs).map_err(|_| ())?.f_type as u64 != PROCFS_MAGIC
        || !has_cloexec(procfs)?
        || !is_read_only_no_append(procfs)?
    {
        return Err(());
    }
    descriptor_identity(procfs)
}

fn open_clock_sys(procfs: &OwnedFd) -> Result<(OwnedFd, FileIdentity), ()> {
    let sys = openat2(
        procfs,
        c"sys",
        DIRECTORY_READ_FLAGS,
        Mode::empty(),
        SYS_RESOLVE,
    )
    .map_err(|_| ())?;
    verify_procfs_component(&sys, FileType::Directory, 0o555, 1, 0)?;
    let identity = descriptor_identity(&sys)?;
    let reopened = openat2(
        procfs,
        c"sys",
        DIRECTORY_READ_FLAGS,
        Mode::empty(),
        SYS_RESOLVE,
    )
    .map_err(|_| ())?;
    verify_procfs_component(&reopened, FileType::Directory, 0o555, 1, 0)?;
    if descriptor_identity(&reopened)? != identity {
        return Err(());
    }
    Ok((sys, identity))
}

fn open_boot_id(sys: &OwnedFd) -> Result<(OwnedFd, FileIdentity), ()> {
    let boot_id = openat2(
        sys,
        c"kernel/random/boot_id",
        READ_FLAGS,
        Mode::empty(),
        RESOLVE,
    )
    .map_err(|_| ())?;
    verify_procfs_component(&boot_id, FileType::RegularFile, 0o444, 1, 0)?;
    let identity = descriptor_identity(&boot_id)?;
    let reopened = openat2(
        sys,
        c"kernel/random/boot_id",
        READ_FLAGS,
        Mode::empty(),
        RESOLVE,
    )
    .map_err(|_| ())?;
    verify_procfs_component(&reopened, FileType::RegularFile, 0o444, 1, 0)?;
    if descriptor_identity(&reopened)? != identity {
        return Err(());
    }
    Ok((boot_id, identity))
}

fn verify_procfs_component(
    fd: &OwnedFd,
    file_type: FileType,
    mode: u32,
    nlink: u64,
    size: i64,
) -> Result<(), ()> {
    let stat = fstat(fd).map_err(|_| ())?;
    verify_metadata(
        &stat,
        Owner {
            uid: 0,
            gid: 0,
            dev: stat.st_dev,
        },
        file_type,
        mode,
        nlink,
    )?;
    if stat.st_size != size
        || fstatfs(fd).map_err(|_| ())?.f_type as u64 != PROCFS_MAGIC
        || !has_cloexec(fd)?
        || !is_read_only_no_append(fd)?
    {
        return Err(());
    }
    Ok(())
}

fn descriptor_identity(fd: &OwnedFd) -> Result<FileIdentity, ()> {
    let value = statx(fd, c"", AtFlags::EMPTY_PATH, REQUIRED_STATX).map_err(|_| ())?;
    if value.stx_mask & REQUIRED_STATX.bits() != REQUIRED_STATX.bits() {
        return Err(());
    }
    Ok(FileIdentity {
        dev_major: value.stx_dev_major,
        dev_minor: value.stx_dev_minor,
        inode: value.stx_ino,
        mount_id: value.stx_mnt_id,
    })
}

pub(crate) struct RegistrySigner {
    fd: OwnedFd,
    key: SigningKey,
    owner: Owner,
    inode: u64,
}

impl RegistrySigner {
    pub(crate) fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    pub(crate) fn verifying_key_bytes(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }
}

pub(crate) fn inspect_registry_seed(
    fd: OwnedFd,
    expected: ExpectedOwner,
) -> Result<RegistrySigner, ()> {
    let stat = fstat(&fd).map_err(|_| ())?;
    let owner = Owner {
        uid: expected.uid(),
        gid: expected.gid(),
        dev: stat.st_dev,
    };
    verify_registry_seed_descriptor(&fd, owner)?;
    let seed = read_registry_seed_once(&fd)?;
    if *seed != [0x5a; 32] {
        return Err(());
    }
    let key = SigningKey::from_bytes(&seed);
    Ok(RegistrySigner {
        fd,
        key,
        owner,
        inode: stat.st_ino,
    })
}

fn read_registry_seed_once(fd: &OwnedFd) -> Result<Zeroizing<[u8; 32]>, ()> {
    #[cfg(test)]
    REGISTRY_SEED_PREADS.with(|count| count.set(count.get() + 1));
    let mut seed = Zeroizing::new([0_u8; 32]);
    if rustix::io::pread(fd, &mut seed[..], 0).map_err(|_| ())? != seed.len() {
        return Err(());
    }
    Ok(seed)
}

#[cfg(test)]
std::thread_local! {
    static REGISTRY_SEED_PREADS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn reset_registry_seed_pread_count() {
    REGISTRY_SEED_PREADS.set(0);
}

#[cfg(test)]
pub(crate) fn registry_seed_pread_count() -> usize {
    REGISTRY_SEED_PREADS.get()
}

pub(crate) fn revalidate_registry_seed(signer: &RegistrySigner) -> Result<(), ()> {
    let stat = fstat(&signer.fd).map_err(|_| ())?;
    if stat.st_ino != signer.inode {
        return Err(());
    }
    verify_registry_seed_descriptor(&signer.fd, signer.owner)
}

fn verify_registry_seed_descriptor(fd: &OwnedFd, owner: Owner) -> Result<(), ()> {
    let stat = fstat(fd).map_err(|_| ())?;
    verify_metadata(&stat, owner, FileType::RegularFile, 0o600, 0)?;
    let flags = fcntl(fd, FcntlArg::F_GETFL).map_err(|_| ())?;
    let seals = SealFlag::from_bits(fcntl(fd, FcntlArg::F_GET_SEALS).map_err(|_| ())?).ok_or(())?;
    let required = SealFlag::F_SEAL_WRITE
        | SealFlag::F_SEAL_GROW
        | SealFlag::F_SEAL_SHRINK
        | SealFlag::F_SEAL_SEAL;
    if stat.st_size != 32
        || fstatfs(fd).map_err(|_| ())?.f_type as u64 != TMPFS_MAGIC
        || !has_cloexec(fd)?
        || OFlag::from_bits_truncate(flags) & OFlag::O_ACCMODE != OFlag::O_RDWR
        || !seals.contains(required)
    {
        return Err(());
    }
    Ok(())
}

pub(crate) struct RegistryGenerationOne(VerifiedRegistryScan);

struct VerifiedRegistryScan {
    root: OwnedFd,
    format: OwnedFd,
    objects: OwnedFd,
    records: OwnedFd,
    signatures: OwnedFd,
    transitions: OwnedFd,
    transition: OwnedFd,
    record: OwnedFd,
    signature: OwnedFd,
    authorization_record: OwnedFd,
    authorization_signature: OwnedFd,
    record_sha256: String,
}

pub(crate) struct PendingRegistryGenerationOne<'a> {
    state_root: &'a OwnedFd,
    root: &'a OwnedFd,
    format: OwnedFd,
    objects: &'a OwnedFd,
    records: &'a OwnedFd,
    signatures: &'a OwnedFd,
    transitions: &'a OwnedFd,
    authorization_record: OwnedFd,
    authorization_signature: OwnedFd,
    record: OwnedFd,
    signature: OwnedFd,
    authorization_record_name: CString,
    authorization_signature_name: CString,
    record_name: CString,
    signature_name: CString,
    authorization_bytes: Vec<u8>,
    authorization_signature_bytes: Vec<u8>,
    record_bytes: Vec<u8>,
    signature_bytes: Vec<u8>,
    owner: RootOwner,
}

pub(crate) struct GenerationOneBindings<'a> {
    pub(crate) auth_bytes: &'a [u8],
    pub(crate) auth_signature: &'a [u8; 64],
    pub(crate) bootstrap: &'a BootstrapLease,
    pub(crate) held: &'a HeldStateRoot,
    pub(crate) journal: &'a EmptyPreparationJournal,
    pub(crate) installed_at: String,
}

#[derive(Clone, Copy)]
pub(crate) enum RegistryPublicationError {
    BeforeFinal,
    OutcomeUnknown,
}

pub(crate) fn create_generation_one(
    bindings: GenerationOneBindings<'_>,
    signing_key: &SigningKey,
    before_transition: impl FnOnce(&PendingRegistryGenerationOne<'_>) -> Result<(), ()>,
) -> Result<RegistryGenerationOne, RegistryPublicationError> {
    let early = |_| RegistryPublicationError::BeforeFinal;
    let root = create_directory(
        &bindings.held.root,
        "AUTHORITY_REGISTRY",
        bindings.held.owner,
    )
    .map_err(early)?;
    publish(
        &root,
        "FORMAT",
        REGISTRY_FORMAT,
        bindings.held.owner.storage(),
    )
    .map_err(early)?;
    let format = open_regular(
        &root,
        c"FORMAT",
        bindings.held.owner.storage(),
        REGISTRY_FORMAT.len(),
        false,
    )
    .map_err(early)?;
    let objects = create_directory(&root, "objects", bindings.held.owner).map_err(early)?;
    let records = create_directory(&objects, "records", bindings.held.owner).map_err(early)?;
    let signatures =
        create_directory(&objects, "signatures", bindings.held.owner).map_err(early)?;
    let transitions = create_directory(&root, "transitions", bindings.held.owner).map_err(early)?;
    let auth_sha = sha256_hex(bindings.auth_bytes);
    let auth_signature_sha = sha256_hex(bindings.auth_signature);
    publish(
        &signatures,
        &auth_signature_sha,
        bindings.auth_signature,
        bindings.held.owner.storage(),
    )
    .map_err(early)?;
    publish(
        &records,
        &auth_sha,
        bindings.auth_bytes,
        bindings.held.owner.storage(),
    )
    .map_err(early)?;
    let unsigned = encode_registry_unsigned(&bindings, &auth_sha, &auth_signature_sha, signing_key);
    let signature = signing_key.sign(&signature_preimage(
        "openspell.hosted-migration-authority-registry-signature.v1",
        &unsigned,
    ));
    let signature_bytes = signature.to_bytes();
    let signature_sha = sha256_hex(&signature_bytes);
    let complete = encode_registry_complete(&unsigned, &signature_sha);
    let record_sha = sha256_hex(&complete);
    publish(
        &signatures,
        &signature_sha,
        &signature_bytes,
        bindings.held.owner.storage(),
    )
    .map_err(early)?;
    publish(
        &records,
        &record_sha,
        &complete,
        bindings.held.owner.storage(),
    )
    .map_err(early)?;
    let pending = verify_pending_generation_one(
        &bindings.held.root,
        &root,
        format,
        &objects,
        &records,
        &signatures,
        &transitions,
        bindings.held.owner,
        bindings.auth_bytes,
        bindings.auth_signature,
        &auth_sha,
        &auth_signature_sha,
        &complete,
        &record_sha,
        &signature_bytes,
        &signature_sha,
    )
    .map_err(early)?;
    let transition_name = format!("{:020}-{record_sha}.json", 1_u64);
    let transition_name =
        CString::new(transition_name).map_err(|_| RegistryPublicationError::BeforeFinal)?;
    #[cfg(test)]
    crate::journal::storage::test_registry_before_final_validation_cut().map_err(early)?;
    before_transition(&pending).map_err(early)?;
    publish_registry_final(
        &transitions,
        &transition_name,
        &complete,
        bindings.held.owner.storage(),
    )
    .map_err(|error| match error {
        RegistryFinalPublicationError::BeforeFinalName => RegistryPublicationError::BeforeFinal,
        RegistryFinalPublicationError::AfterFinalName => RegistryPublicationError::OutcomeUnknown,
    })?;
    fsync(&root).map_err(|_| RegistryPublicationError::OutcomeUnknown)?;
    fsync(&bindings.held.root).map_err(|_| RegistryPublicationError::OutcomeUnknown)?;
    inspect_generation_one(bindings.held, bindings.bootstrap, bindings.journal)
        .map_err(|_| RegistryPublicationError::OutcomeUnknown)
}

#[allow(clippy::too_many_arguments)]
fn verify_pending_generation_one<'a>(
    state_root: &'a OwnedFd,
    root: &'a OwnedFd,
    format: OwnedFd,
    objects: &'a OwnedFd,
    records: &'a OwnedFd,
    signatures: &'a OwnedFd,
    transitions: &'a OwnedFd,
    owner: RootOwner,
    auth_bytes: &[u8],
    auth_signature: &[u8; 64],
    auth_sha: &str,
    auth_signature_sha: &str,
    record_bytes: &[u8],
    record_sha: &str,
    signature: &[u8; 64],
    signature_sha: &str,
) -> Result<PendingRegistryGenerationOne<'a>, ()> {
    require_names(root, &["FORMAT", "objects", "transitions"])?;
    require_names(objects, &["records", "signatures"])?;
    require_names(transitions, &[])?;
    require_names(records, &[auth_sha, record_sha])?;
    require_names(signatures, &[auth_signature_sha, signature_sha])?;
    let authorization_record_name = CString::new(auth_sha).map_err(|_| ())?;
    let authorization_signature_name = CString::new(auth_signature_sha).map_err(|_| ())?;
    let record_name = CString::new(record_sha).map_err(|_| ())?;
    let signature_name = CString::new(signature_sha).map_err(|_| ())?;
    let authorization_record = open_regular(
        records,
        &authorization_record_name,
        owner.storage(),
        auth_bytes.len(),
        false,
    )?;
    let authorization_signature = open_regular(
        signatures,
        &authorization_signature_name,
        owner.storage(),
        auth_signature.len(),
        false,
    )?;
    let record = open_regular(
        records,
        &record_name,
        owner.storage(),
        record_bytes.len(),
        false,
    )?;
    let signature_fd = open_regular(
        signatures,
        &signature_name,
        owner.storage(),
        signature.len(),
        false,
    )?;
    let pending = PendingRegistryGenerationOne {
        state_root,
        root,
        format,
        objects,
        records,
        signatures,
        transitions,
        authorization_record,
        authorization_signature,
        record,
        signature: signature_fd,
        authorization_record_name,
        authorization_signature_name,
        record_name,
        signature_name,
        authorization_bytes: auth_bytes.to_vec(),
        authorization_signature_bytes: auth_signature.to_vec(),
        record_bytes: record_bytes.to_vec(),
        signature_bytes: signature.to_vec(),
        owner,
    };
    pending.revalidate()?;
    Ok(pending)
}

impl PendingRegistryGenerationOne<'_> {
    pub(crate) fn revalidate(&self) -> Result<(), ()> {
        require_names(self.root, &["FORMAT", "objects", "transitions"])?;
        require_names(self.objects, &["records", "signatures"])?;
        require_names(self.transitions, &[])?;
        verify_entry_matches_fd(
            self.state_root,
            c"AUTHORITY_REGISTRY",
            self.root,
            self.owner.storage(),
            FileType::Directory,
            0o700,
            4,
        )?;
        verify_entry_matches_fd(
            self.root,
            c"FORMAT",
            &self.format,
            self.owner.storage(),
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if read_exact_file(&self.format, REGISTRY_FORMAT.len())? != REGISTRY_FORMAT {
            return Err(());
        }
        require_names(
            self.records,
            &[
                self.authorization_record_name.to_str().map_err(|_| ())?,
                self.record_name.to_str().map_err(|_| ())?,
            ],
        )?;
        require_names(
            self.signatures,
            &[
                self.authorization_signature_name.to_str().map_err(|_| ())?,
                self.signature_name.to_str().map_err(|_| ())?,
            ],
        )?;
        verify_entry_matches_fd(
            self.root,
            c"objects",
            self.objects,
            self.owner.storage(),
            FileType::Directory,
            0o700,
            4,
        )?;
        verify_entry_matches_fd(
            self.objects,
            c"records",
            self.records,
            self.owner.storage(),
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            self.objects,
            c"signatures",
            self.signatures,
            self.owner.storage(),
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            self.root,
            c"transitions",
            self.transitions,
            self.owner.storage(),
            FileType::Directory,
            0o700,
            2,
        )?;
        for (parent, name, fd, expected) in [
            (
                self.records,
                &self.authorization_record_name,
                &self.authorization_record,
                self.authorization_bytes.as_slice(),
            ),
            (
                self.records,
                &self.record_name,
                &self.record,
                self.record_bytes.as_slice(),
            ),
            (
                self.signatures,
                &self.authorization_signature_name,
                &self.authorization_signature,
                self.authorization_signature_bytes.as_slice(),
            ),
            (
                self.signatures,
                &self.signature_name,
                &self.signature,
                self.signature_bytes.as_slice(),
            ),
        ] {
            verify_entry_matches_fd(
                parent,
                name,
                fd,
                self.owner.storage(),
                FileType::RegularFile,
                0o600,
                1,
            )?;
            if read_exact_file(fd, expected.len())? != expected {
                return Err(());
            }
        }
        Ok(())
    }
}

pub(crate) fn inspect_generation_one(
    held: &HeldStateRoot,
    bootstrap: &BootstrapLease,
    journal: &EmptyPreparationJournal,
) -> Result<RegistryGenerationOne, ()> {
    let first = scan_generation_one(held, bootstrap, journal)?;
    for fd in [
        &first.transition,
        &first.record,
        &first.signature,
        &first.authorization_record,
        &first.authorization_signature,
    ] {
        fsync(fd).map_err(|_| ())?;
    }
    for directory in [
        &first.records,
        &first.signatures,
        &first.transitions,
        &first.objects,
        &first.root,
        &held.root,
    ] {
        fsync(directory).map_err(|_| ())?;
    }
    let record_sha256 = first.record_sha256.clone();
    drop(first);
    let reopened = scan_generation_one(held, bootstrap, journal)?;
    if reopened.record_sha256 != record_sha256 {
        return Err(());
    }
    #[cfg(test)]
    crate::journal::storage::test_registry_post_durability_cut()?;
    Ok(RegistryGenerationOne(reopened))
}

pub(crate) fn revalidate_generation_one(
    current: &RegistryGenerationOne,
    held: &HeldStateRoot,
    bootstrap: &BootstrapLease,
    journal: &EmptyPreparationJournal,
) -> Result<(), ()> {
    let reopened = scan_generation_one(held, bootstrap, journal)?;
    compare_registry_descriptor_graph(&current.0, &reopened)
}

fn compare_registry_descriptor_graph(
    retained: &VerifiedRegistryScan,
    reopened: &VerifiedRegistryScan,
) -> Result<(), ()> {
    if retained.record_sha256 != reopened.record_sha256 {
        return Err(());
    }
    for (left, right) in [
        (&retained.root, &reopened.root),
        (&retained.format, &reopened.format),
        (&retained.objects, &reopened.objects),
        (&retained.records, &reopened.records),
        (&retained.signatures, &reopened.signatures),
        (&retained.transitions, &reopened.transitions),
        (&retained.transition, &reopened.transition),
        (&retained.record, &reopened.record),
        (&retained.signature, &reopened.signature),
        (
            &retained.authorization_record,
            &reopened.authorization_record,
        ),
        (
            &retained.authorization_signature,
            &reopened.authorization_signature,
        ),
    ] {
        let left = fstat(left).map_err(|_| ())?;
        let right = fstat(right).map_err(|_| ())?;
        if left.st_dev != right.st_dev || left.st_ino != right.st_ino {
            return Err(());
        }
    }
    Ok(())
}

fn scan_generation_one(
    held: &HeldStateRoot,
    bootstrap: &BootstrapLease,
    journal: &EmptyPreparationJournal,
) -> Result<VerifiedRegistryScan, ()> {
    let root = open_directory_any_links(&held.root, "AUTHORITY_REGISTRY", held.owner)?;
    require_names(&root, &["FORMAT", "objects", "transitions"])?;
    let format = open_regular(
        &root,
        c"FORMAT",
        held.owner.storage(),
        REGISTRY_FORMAT.len(),
        false,
    )?;
    if read_exact_file(&format, REGISTRY_FORMAT.len())? != REGISTRY_FORMAT {
        return Err(());
    }
    let objects = open_directory_any_links(&root, "objects", held.owner)?;
    require_names(&objects, &["records", "signatures"])?;
    let records = open_directory_any_links(&objects, "records", held.owner)?;
    let signatures = open_directory_any_links(&objects, "signatures", held.owner)?;
    let transitions = open_directory_any_links(&root, "transitions", held.owner)?;
    let transition_names = read_names(&transitions, MAX_REGISTRY_TRANSITIONS)?;
    if transition_names.len() != 1 {
        return Err(());
    }
    let transition_name = transition_names.first().ok_or(())?;
    if transition_name.len() != 20 + 1 + 64 + 5
        || !transition_name.starts_with("00000000000000000001-")
    {
        return Err(());
    }
    let record_sha = &transition_name[21..85];
    if !is_lower_hex(record_sha, 32) || &transition_name[85..] != ".json" {
        return Err(());
    }
    let transition_c = CString::new(transition_name.as_bytes()).map_err(|_| ())?;
    let transition = open_dynamic_record(&transitions, &transition_c, held.owner.storage())?;
    let size = usize::try_from(fstat(&transition).map_err(|_| ())?.st_size).map_err(|_| ())?;
    let complete = read_exact_file(&transition, size)?;
    if sha256_hex(&complete) != record_sha {
        return Err(());
    }
    let record_c = CString::new(record_sha.as_bytes()).map_err(|_| ())?;
    let record = open_dynamic_record(&records, &record_c, held.owner.storage())?;
    if read_exact_file(&record, size)? != complete {
        return Err(());
    }
    let parsed: RegistryRecord = decode_exact(&complete, encode_registry_record)?;
    verify_registry_record(&parsed, held, bootstrap, journal)?;
    let record_names = read_names(&records, MAX_REGISTRY_RECORDS)?;
    let signature_names = read_names(&signatures, MAX_REGISTRY_SIGNATURES)?;
    if record_names.len() != 2 || signature_names.len() != 2 {
        return Err(());
    }
    for digest in [
        &parsed.installation_authorization_sha256,
        &parsed.installation_authorization_signature_sha256,
        &parsed.detached_signature_sha256,
    ] {
        if !is_lower_hex(digest, 32) {
            return Err(());
        }
    }
    if !record_names.contains(&record_sha.to_owned())
        || !record_names.contains(&parsed.installation_authorization_sha256)
        || !signature_names.contains(&parsed.detached_signature_sha256)
        || !signature_names.contains(&parsed.installation_authorization_signature_sha256)
    {
        return Err(());
    }
    let signature_c = CString::new(parsed.detached_signature_sha256.as_bytes()).map_err(|_| ())?;
    let signature = open_regular(&signatures, &signature_c, held.owner.storage(), 64, false)?;
    let signature_bytes: [u8; 64] = read_exact_file(&signature, 64)?
        .try_into()
        .map_err(|_| ())?;
    if sha256_hex(&signature_bytes) != parsed.detached_signature_sha256 {
        return Err(());
    }
    verify_signature(
        "openspell.hosted-migration-authority-registry-signature.v1",
        &encode_registry_unsigned_from_record(&parsed),
        &signature_bytes,
        &bootstrap.policy.registry_key,
    )?;
    let auth_record_c =
        CString::new(parsed.installation_authorization_sha256.as_bytes()).map_err(|_| ())?;
    let auth_record = open_dynamic_record(&records, &auth_record_c, held.owner.storage())?;
    let auth_size =
        usize::try_from(fstat(&auth_record).map_err(|_| ())?.st_size).map_err(|_| ())?;
    let auth_bytes = read_exact_file(&auth_record, auth_size)?;
    if sha256_hex(&auth_bytes) != parsed.installation_authorization_sha256 {
        return Err(());
    }
    let auth_signature_c = CString::new(
        parsed
            .installation_authorization_signature_sha256
            .as_bytes(),
    )
    .map_err(|_| ())?;
    let auth_signature_fd = open_regular(
        &signatures,
        &auth_signature_c,
        held.owner.storage(),
        64,
        false,
    )?;
    let auth_signature: [u8; 64] = read_exact_file(&auth_signature_fd, 64)?
        .try_into()
        .map_err(|_| ())?;
    let total_bytes = REGISTRY_FORMAT
        .len()
        .checked_add(complete.len().checked_mul(2).ok_or(())?)
        .and_then(|total| total.checked_add(auth_size))
        .and_then(|total| total.checked_add(128))
        .ok_or(())?;
    if total_bytes > MAX_REGISTRY_TOTAL_BYTES {
        return Err(());
    }
    let auth: InstallationAuthorization = decode_exact(&auth_bytes, encode_installation)?;
    if auth.detached_signature_sha256 != parsed.installation_authorization_signature_sha256 {
        return Err(());
    }
    validate_installation_bindings(
        &auth,
        &auth_signature,
        bootstrap,
        &held.root_identity_sha256,
        &bootstrap.policy.registry_key,
    )?;
    validate_installation_time_shape(&auth)?;
    let installed_at = validate_millisecond_timestamp(&parsed.installed_at).map_err(|_| ())?;
    let issued_at = validate_millisecond_timestamp(&auth.issued_at).map_err(|_| ())?;
    let expires_at = validate_millisecond_timestamp(&auth.expires_at).map_err(|_| ())?;
    if installed_at < issued_at || installed_at > expires_at {
        return Err(());
    }
    verify_signature(
        "openspell.preparation-state-root-installation-authorization-signature.v1",
        &encode_installation_unsigned(&auth),
        &auth_signature,
        &bootstrap.policy.root_issuer_key,
    )?;
    verify_entry_matches_fd(
        &held.root,
        c"AUTHORITY_REGISTRY",
        &root,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    verify_entry_matches_fd(
        &root,
        c"objects",
        &objects,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    verify_entry_matches_fd(
        &objects,
        c"records",
        &records,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &objects,
        c"signatures",
        &signatures,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &root,
        c"transitions",
        &transitions,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    Ok(VerifiedRegistryScan {
        root,
        format,
        objects,
        records,
        signatures,
        transitions,
        transition,
        record,
        signature,
        authorization_record: auth_record,
        authorization_signature: auth_signature_fd,
        record_sha256: record_sha.to_owned(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryRecord {
    schema_version: String,
    registry_generation: u64,
    previous_registry_record_sha256: String,
    active_format: String,
    active_journal_name: String,
    active_journal_identity_sha256: String,
    authority_super_lock_identity_sha256: String,
    installation_authorization_sha256: String,
    installation_authorization_signature_sha256: String,
    bound_state_root_identity_sha256: String,
    preparation_policy_sha256: String,
    proof_bootstrap_registry_sha256: String,
    proof_bootstrap_verifier_identity_sha256: String,
    proof_bootstrap_manifest_sha256: String,
    proof_bootstrap_lock_identity_sha256: String,
    source_revision: String,
    privileged_executable_policy_sha256: String,
    privileged_executable_policy_generation: u64,
    active_target_fingerprint: Option<String>,
    active_target_generation: u64,
    other_format_disposition: String,
    other_format_terminal_transition_sha256: Option<String>,
    installed_at: String,
    issuer_public_key_sha256: String,
    detached_signature_sha256: String,
}

fn verify_registry_record(
    record: &RegistryRecord,
    held: &HeldStateRoot,
    bootstrap: &BootstrapLease,
    journal: &EmptyPreparationJournal,
) -> Result<(), ()> {
    if record.schema_version != "openspell.hosted-migration-authority-registry.v1"
        || record.registry_generation != 1
        || record.previous_registry_record_sha256 != REGISTRY_GENESIS
        || record.active_format != "preparation_v2"
        || record.active_journal_name != "PREPARATION_JOURNAL_V2"
        || record.active_journal_identity_sha256 != journal.identity_sha256
        || record.authority_super_lock_identity_sha256 != held.lock_identity_sha256
        || record.bound_state_root_identity_sha256 != held.root_identity_sha256
        || record.preparation_policy_sha256 != POLICY_SHA256
        || record.proof_bootstrap_registry_sha256 != bootstrap.registry_sha256
        || record.proof_bootstrap_verifier_identity_sha256
            != bootstrap.policy.bootstrap_verifier_sha256
        || record.proof_bootstrap_manifest_sha256 != bootstrap.policy.bootstrap_manifest_sha256
        || record.proof_bootstrap_lock_identity_sha256 != bootstrap.lock_identity_sha256
        || record.source_revision != bootstrap.policy.source_revision
        || record.privileged_executable_policy_sha256 != bootstrap.policy.executable_policy_sha256
        || record.privileged_executable_policy_generation != 0
        || record.active_target_fingerprint.is_some()
        || record.active_target_generation != 0
        || record.other_format_disposition != "absent"
        || record.other_format_terminal_transition_sha256.is_some()
        || record.issuer_public_key_sha256 != sha256_hex(&bootstrap.policy.registry_key)
        || validate_millisecond_timestamp(&record.installed_at).is_err()
    {
        return Err(());
    }
    Ok(())
}

fn encode_registry_unsigned(
    bindings: &GenerationOneBindings<'_>,
    auth_sha: &str,
    auth_signature_sha: &str,
    signing_key: &SigningKey,
) -> Vec<u8> {
    json_object(&[
        (
            "schemaVersion",
            J::S("openspell.hosted-migration-authority-registry.v1"),
        ),
        ("registryGeneration", J::U(1)),
        ("previousRegistryRecordSha256", J::S(REGISTRY_GENESIS)),
        ("activeFormat", J::S("preparation_v2")),
        ("activeJournalName", J::S("PREPARATION_JOURNAL_V2")),
        (
            "activeJournalIdentitySha256",
            J::S(&bindings.journal.identity_sha256),
        ),
        (
            "authoritySuperLockIdentitySha256",
            J::S(&bindings.held.lock_identity_sha256),
        ),
        ("installationAuthorizationSha256", J::S(auth_sha)),
        (
            "installationAuthorizationSignatureSha256",
            J::S(auth_signature_sha),
        ),
        (
            "boundStateRootIdentitySha256",
            J::S(&bindings.held.root_identity_sha256),
        ),
        ("preparationPolicySha256", J::S(POLICY_SHA256)),
        (
            "proofBootstrapRegistrySha256",
            J::S(&bindings.bootstrap.registry_sha256),
        ),
        (
            "proofBootstrapVerifierIdentitySha256",
            J::S(&bindings.bootstrap.policy.bootstrap_verifier_sha256),
        ),
        (
            "proofBootstrapManifestSha256",
            J::S(&bindings.bootstrap.policy.bootstrap_manifest_sha256),
        ),
        (
            "proofBootstrapLockIdentitySha256",
            J::S(&bindings.bootstrap.lock_identity_sha256),
        ),
        (
            "sourceRevision",
            J::S(&bindings.bootstrap.policy.source_revision),
        ),
        (
            "privilegedExecutablePolicySha256",
            J::S(&bindings.bootstrap.policy.executable_policy_sha256),
        ),
        ("privilegedExecutablePolicyGeneration", J::U(0)),
        ("activeTargetFingerprint", J::N),
        ("activeTargetGeneration", J::U(0)),
        ("otherFormatDisposition", J::S("absent")),
        ("otherFormatTerminalTransitionSha256", J::N),
        ("installedAt", J::S(&bindings.installed_at)),
        (
            "issuerPublicKeySha256",
            J::S(&sha256_hex(&signing_key.verifying_key().to_bytes())),
        ),
    ])
}

fn encode_registry_complete(unsigned: &[u8], signature_sha: &str) -> Vec<u8> {
    append_final_field(unsigned, "detachedSignatureSha256", signature_sha)
}

fn encode_registry_record(value: &RegistryRecord) -> Vec<u8> {
    append_final_field(
        &encode_registry_unsigned_from_record(value),
        "detachedSignatureSha256",
        &value.detached_signature_sha256,
    )
}

fn encode_registry_unsigned_from_record(value: &RegistryRecord) -> Vec<u8> {
    json_object(&[
        ("schemaVersion", J::S(&value.schema_version)),
        ("registryGeneration", J::U(value.registry_generation)),
        (
            "previousRegistryRecordSha256",
            J::S(&value.previous_registry_record_sha256),
        ),
        ("activeFormat", J::S(&value.active_format)),
        ("activeJournalName", J::S(&value.active_journal_name)),
        (
            "activeJournalIdentitySha256",
            J::S(&value.active_journal_identity_sha256),
        ),
        (
            "authoritySuperLockIdentitySha256",
            J::S(&value.authority_super_lock_identity_sha256),
        ),
        (
            "installationAuthorizationSha256",
            J::S(&value.installation_authorization_sha256),
        ),
        (
            "installationAuthorizationSignatureSha256",
            J::S(&value.installation_authorization_signature_sha256),
        ),
        (
            "boundStateRootIdentitySha256",
            J::S(&value.bound_state_root_identity_sha256),
        ),
        (
            "preparationPolicySha256",
            J::S(&value.preparation_policy_sha256),
        ),
        (
            "proofBootstrapRegistrySha256",
            J::S(&value.proof_bootstrap_registry_sha256),
        ),
        (
            "proofBootstrapVerifierIdentitySha256",
            J::S(&value.proof_bootstrap_verifier_identity_sha256),
        ),
        (
            "proofBootstrapManifestSha256",
            J::S(&value.proof_bootstrap_manifest_sha256),
        ),
        (
            "proofBootstrapLockIdentitySha256",
            J::S(&value.proof_bootstrap_lock_identity_sha256),
        ),
        ("sourceRevision", J::S(&value.source_revision)),
        (
            "privilegedExecutablePolicySha256",
            J::S(&value.privileged_executable_policy_sha256),
        ),
        (
            "privilegedExecutablePolicyGeneration",
            J::U(value.privileged_executable_policy_generation),
        ),
        (
            "activeTargetFingerprint",
            value
                .active_target_fingerprint
                .as_deref()
                .map_or(J::N, J::S),
        ),
        (
            "activeTargetGeneration",
            J::U(value.active_target_generation),
        ),
        (
            "otherFormatDisposition",
            J::S(&value.other_format_disposition),
        ),
        (
            "otherFormatTerminalTransitionSha256",
            value
                .other_format_terminal_transition_sha256
                .as_deref()
                .map_or(J::N, J::S),
        ),
        ("installedAt", J::S(&value.installed_at)),
        (
            "issuerPublicKeySha256",
            J::S(&value.issuer_public_key_sha256),
        ),
    ])
}

fn encode_bootstrap(value: &BootstrapRecord) -> Vec<u8> {
    append_final_field(
        &encode_bootstrap_unsigned(value),
        "detachedSignatureSha256",
        &value.detached_signature_sha256,
    )
}

fn encode_bootstrap_unsigned(value: &BootstrapRecord) -> Vec<u8> {
    json_object(&[
        ("schemaVersion", J::S(&value.schema_version)),
        ("registryGeneration", J::U(value.registry_generation)),
        (
            "previousRegistryRecordSha256",
            J::S(&value.previous_registry_record_sha256),
        ),
        ("currentPolicySha256", J::S(&value.current_policy_sha256)),
        (
            "currentManifestSha256",
            J::S(&value.current_manifest_sha256),
        ),
        (
            "bootstrapVerifierIdentitySha256",
            J::S(&value.bootstrap_verifier_identity_sha256),
        ),
        (
            "bootstrapLockIdentitySha256",
            J::S(&value.bootstrap_lock_identity_sha256),
        ),
        ("sourceRevision", J::S(&value.source_revision)),
        ("activatedAt", J::S(&value.activated_at)),
        (
            "issuerPublicKeySha256",
            J::S(&value.issuer_public_key_sha256),
        ),
    ])
}

fn encode_installation(value: &InstallationAuthorization) -> Vec<u8> {
    append_final_field(
        &encode_installation_unsigned(value),
        "detachedSignatureSha256",
        &value.detached_signature_sha256,
    )
}

fn encode_installation_unsigned(value: &InstallationAuthorization) -> Vec<u8> {
    json_object(&[
        ("schemaVersion", J::S(&value.schema_version)),
        (
            "installationAuthorizationNonce",
            J::S(&value.installation_authorization_nonce),
        ),
        ("sourceRevision", J::S(&value.source_revision)),
        (
            "proofBootstrapRegistrySha256",
            J::S(&value.proof_bootstrap_registry_sha256),
        ),
        (
            "proofBootstrapVerifierIdentitySha256",
            J::S(&value.proof_bootstrap_verifier_identity_sha256),
        ),
        (
            "proofBootstrapManifestSha256",
            J::S(&value.proof_bootstrap_manifest_sha256),
        ),
        (
            "proofBootstrapLockIdentitySha256",
            J::S(&value.proof_bootstrap_lock_identity_sha256),
        ),
        (
            "boundStateRootIdentitySha256",
            J::S(&value.bound_state_root_identity_sha256),
        ),
        (
            "preparationPolicySha256",
            J::S(&value.preparation_policy_sha256),
        ),
        (
            "privilegedExecutablePolicySha256",
            J::S(&value.privileged_executable_policy_sha256),
        ),
        (
            "privilegedExecutablePolicyGeneration",
            J::U(value.privileged_executable_policy_generation),
        ),
        (
            "registrySignerPublicKeySha256",
            J::S(&value.registry_signer_public_key_sha256),
        ),
        (
            "trustedClockProviderSha256",
            J::S(&value.trusted_clock_provider_sha256),
        ),
        ("activeFormat", J::S(&value.active_format)),
        ("activeJournalName", J::S(&value.active_journal_name)),
        ("targetClass", J::S(&value.target_class)),
        ("externalCapability", J::B(value.external_capability)),
        ("liveAdapterAllowed", J::B(value.live_adapter_allowed)),
        (
            "maximumDurationSeconds",
            J::U(value.maximum_duration_seconds),
        ),
        ("issuedAt", J::S(&value.issued_at)),
        ("expiresAt", J::S(&value.expires_at)),
        (
            "authenticatedOperatorIdentitySha256",
            J::S(&value.authenticated_operator_identity_sha256),
        ),
        (
            "osAuthenticationSessionSha256",
            J::S(&value.os_authentication_session_sha256),
        ),
        ("authenticatedAt", J::S(&value.authenticated_at)),
        (
            "issuerPublicKeySha256",
            J::S(&value.issuer_public_key_sha256),
        ),
    ])
}

enum J<'a> {
    S(&'a str),
    U(u64),
    B(bool),
    N,
}

fn json_object(fields: &[(&str, J<'_>)]) -> Vec<u8> {
    let mut out = String::from("{\n");
    for (index, (key, value)) in fields.iter().enumerate() {
        out.push_str("  ");
        out.push_str(&serde_json::to_string(key).expect("static key"));
        out.push_str(": ");
        match value {
            J::S(value) => out.push_str(&serde_json::to_string(value).expect("string")),
            J::U(value) => out.push_str(&value.to_string()),
            J::B(value) => out.push_str(if *value { "true" } else { "false" }),
            J::N => out.push_str("null"),
        }
        if index + 1 != fields.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.extend(["}\n"]);
    out.into_bytes()
}

fn append_final_field(unsigned: &[u8], key: &str, value: &str) -> Vec<u8> {
    let mut text = String::from_utf8(unsigned.to_vec()).expect("canonical utf8");
    assert!(text.ends_with("\n}\n"), "canonical object suffix");
    text.truncate(text.len() - 3);
    text.push_str(",\n  ");
    text.push_str(&serde_json::to_string(key).expect("static key"));
    text.push_str(": ");
    text.push_str(&serde_json::to_string(value).expect("digest"));
    text.push_str("\n}\n");
    text.into_bytes()
}

fn decode_exact<T>(bytes: &[u8], encode: fn(&T) -> Vec<u8>) -> Result<T, ()>
where
    T: for<'de> Deserialize<'de>,
{
    if bytes.is_empty() || bytes.len() > MAX_RECORD {
        return Err(());
    }
    let value = serde_json::from_slice(bytes).map_err(|_| ())?;
    if encode(&value) != bytes {
        return Err(());
    }
    Ok(value)
}

fn signature_preimage(domain: &str, unsigned: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(domain.len() + 1 + unsigned.len());
    out.extend_from_slice(domain.as_bytes());
    out.push(b'\n');
    out.extend_from_slice(unsigned);
    out
}

fn verify_signature(
    domain: &str,
    unsigned: &[u8],
    signature: &[u8; 64],
    key: &[u8; 32],
) -> Result<(), ()> {
    VerifyingKey::from_bytes(key)
        .map_err(|_| ())?
        .verify_strict(
            &signature_preimage(domain, unsigned),
            &Signature::from_bytes(signature),
        )
        .map_err(|_| ())
}

fn bootstrap_lock_identity(lock: &OwnedFd, uid: u32, gid: u32) -> Result<String, ()> {
    let stat = fstat(lock).map_err(|_| ())?;
    if stat.st_size != 0 {
        return Err(());
    }
    let canonical = json_object(&[
        (
            "schemaVersion",
            J::S("openspell.synthetic-preparation-proof-bootstrap-lock-identity.v1"),
        ),
        ("filesystemDeviceDecimal", J::S(&stat.st_dev.to_string())),
        ("inodeDecimal", J::S(&stat.st_ino.to_string())),
        ("ownerUid", J::U(u64::from(uid))),
        ("ownerGid", J::U(u64::from(gid))),
        ("modeOctal", J::S("0600")),
        ("linkCount", J::U(1)),
        ("sizeBytes", J::U(0)),
    ]);
    Ok(domain_digest(
        b"openspell.synthetic-preparation-proof-bootstrap-lock-identity.v1\n",
        &canonical,
    ))
}

fn open_dynamic_record(parent: &OwnedFd, name: &CString, owner: Owner) -> Result<OwnedFd, ()> {
    let fd = open_existing(parent, name, READ_FLAGS)?;
    let stat = verify_entry_matches_fd(parent, name, &fd, owner, FileType::RegularFile, 0o600, 1)?;
    if stat.st_size <= 0 || stat.st_size as usize > MAX_RECORD {
        return Err(());
    }
    Ok(fd)
}

fn read_proc_file(root: &OwnedFd, path: &str, max: usize) -> Result<Vec<u8>, ()> {
    let fd = openat2(root, path, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
    pread_bounded(&fd, max)
}

fn validate_boot_id(bytes: &[u8]) -> Result<(), ()> {
    if bytes.len() != 37 || bytes[36] != b'\n' {
        return Err(());
    }
    for (index, byte) in bytes[..36].iter().enumerate() {
        if [8, 13, 18, 23].contains(&index) {
            if *byte != b'-' {
                return Err(());
            }
        } else if !(byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)) {
            return Err(());
        }
    }
    Ok(())
}

fn validate_zero_offsets(bytes: &[u8]) -> Result<(), ()> {
    let text = std::str::from_utf8(bytes).map_err(|_| ())?;
    let rows: Vec<Vec<&str>> = text
        .lines()
        .map(|line| line.split_whitespace().collect())
        .collect();
    if rows != [vec!["monotonic", "0", "0"], vec!["boottime", "0", "0"]] {
        return Err(());
    }
    Ok(())
}

fn pread_exact(fd: &OwnedFd, size: usize) -> Result<Vec<u8>, ()> {
    let bytes = pread_bounded(fd, size + 1)?;
    if bytes.len() != size {
        return Err(());
    }
    Ok(bytes)
}

fn pread_bounded(fd: &OwnedFd, max: usize) -> Result<Vec<u8>, ()> {
    let mut out = Vec::new();
    let mut offset = 0_u64;
    loop {
        let mut chunk = [0_u8; 256];
        let count = rustix::io::pread(fd, &mut chunk, offset).map_err(|_| ())?;
        if count == 0 {
            break;
        }
        if out.len().checked_add(count).ok_or(())? > max {
            return Err(());
        }
        out.extend_from_slice(&chunk[..count]);
        offset = offset.checked_add(count as u64).ok_or(())?;
    }
    Ok(out)
}

fn has_cloexec(fd: &OwnedFd) -> Result<bool, ()> {
    let flags = fcntl(fd, FcntlArg::F_GETFD).map_err(|_| ())?;
    Ok(FdFlag::from_bits_truncate(flags).contains(FdFlag::FD_CLOEXEC))
}

fn is_read_only(fd: &OwnedFd) -> Result<bool, ()> {
    let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL).map_err(|_| ())?);
    Ok(flags & OFlag::O_ACCMODE == OFlag::O_RDONLY)
}

fn is_read_only_no_append(fd: &OwnedFd) -> Result<bool, ()> {
    let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL).map_err(|_| ())?);
    Ok(flags & OFlag::O_ACCMODE == OFlag::O_RDONLY && !flags.contains(OFlag::O_APPEND))
}

fn decode_key(value: &str) -> Result<[u8; 32], ()> {
    hex::decode(value)
        .map_err(|_| ())?
        .try_into()
        .map_err(|_| ())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(crate) fn render_millisecond(value: OffsetDateTime) -> Result<String, ()> {
    let value = value.to_offset(time::UtcOffset::UTC);
    let rendered = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond(),
    );
    validate_millisecond_timestamp(&rendered).map_err(|_| ())?;
    Ok(rendered)
}

#[cfg(test)]
pub(crate) fn build_bootstrap_fixture_record(
    lock: &OwnedFd,
    uid: u32,
    gid: u32,
    activated_at: &str,
) -> (Vec<u8>, [u8; 64]) {
    let key = SigningKey::from_bytes(&[0x11; 32]);
    let mut record = BootstrapRecord {
        schema_version: "openspell.synthetic-preparation-proof-bootstrap-record.v1".into(),
        registry_generation: 0,
        previous_registry_record_sha256: BOOTSTRAP_GENESIS.into(),
        current_policy_sha256: POLICY_SHA256.into(),
        current_manifest_sha256: "8f6f509889310fb71ea2422be4278ae30ac318e37964c532bccc1054b09c176c"
            .into(),
        bootstrap_verifier_identity_sha256:
            "78d763e84d10a60c977a5b897c00907abebc4b5d164fa2f97b97338182d4d477".into(),
        bootstrap_lock_identity_sha256: bootstrap_lock_identity(lock, uid, gid)
            .expect("lock identity"),
        source_revision: "0000000000000000000000000000000000000000".into(),
        activated_at: activated_at.into(),
        issuer_public_key_sha256: sha256_hex(&key.verifying_key().to_bytes()),
        detached_signature_sha256: String::new(),
    };
    let signature = key
        .sign(&signature_preimage(
            "openspell.synthetic-preparation-proof-bootstrap-signature.v1",
            &encode_bootstrap_unsigned(&record),
        ))
        .to_bytes();
    record.detached_signature_sha256 = sha256_hex(&signature);
    (encode_bootstrap(&record), signature)
}

#[cfg(test)]
pub(crate) fn build_installation_fixture(
    lease: &BootstrapLease,
    state_root: &OwnedFd,
    uid: u32,
    gid: u32,
    now: OffsetDateTime,
) -> (Vec<u8>, [u8; 64]) {
    build_installation_fixture_with_duration(lease, state_root, uid, gid, now, 240)
}

#[cfg(test)]
pub(crate) fn build_installation_fixture_with_duration(
    lease: &BootstrapLease,
    state_root: &OwnedFd,
    uid: u32,
    gid: u32,
    now: OffsetDateTime,
    duration_seconds: i64,
) -> (Vec<u8>, [u8; 64]) {
    let root_stat = fstat(state_root).expect("root stat");
    let root_identity = crate::super_lock::state_root_identity(
        state_root,
        RootOwner {
            uid,
            gid,
            dev: root_stat.st_dev,
        },
    )
    .expect("root identity");
    let root_key = SigningKey::from_bytes(&[0x22; 32]);
    let registry_key = SigningKey::from_bytes(&[0x5a; 32])
        .verifying_key()
        .to_bytes();
    let issued = render_millisecond(now).expect("issued");
    let expires =
        render_millisecond(now + time::Duration::seconds(duration_seconds)).expect("expires");
    let mut auth = InstallationAuthorization {
        schema_version: "openspell.preparation-state-root-installation-authorization.v1".into(),
        installation_authorization_nonce:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        source_revision: lease.policy.source_revision.clone(),
        proof_bootstrap_registry_sha256: lease.registry_sha256.clone(),
        proof_bootstrap_verifier_identity_sha256: lease.policy.bootstrap_verifier_sha256.clone(),
        proof_bootstrap_manifest_sha256: lease.policy.bootstrap_manifest_sha256.clone(),
        proof_bootstrap_lock_identity_sha256: lease.lock_identity_sha256.clone(),
        bound_state_root_identity_sha256: root_identity,
        preparation_policy_sha256: POLICY_SHA256.into(),
        privileged_executable_policy_sha256: lease.policy.executable_policy_sha256.clone(),
        privileged_executable_policy_generation: 0,
        registry_signer_public_key_sha256: sha256_hex(&registry_key),
        trusted_clock_provider_sha256: CLOCK_POLICY_SHA256.into(),
        active_format: "preparation_v2".into(),
        active_journal_name: "PREPARATION_JOURNAL_V2".into(),
        target_class: "synthetic_only".into(),
        external_capability: false,
        live_adapter_allowed: false,
        maximum_duration_seconds: 300,
        issued_at: issued.clone(),
        expires_at: expires,
        authenticated_operator_identity_sha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
        os_authentication_session_sha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
        authenticated_at: issued,
        issuer_public_key_sha256: sha256_hex(&root_key.verifying_key().to_bytes()),
        detached_signature_sha256: String::new(),
    };
    let signature = root_key
        .sign(&signature_preimage(
            "openspell.preparation-state-root-installation-authorization-signature.v1",
            &encode_installation_unsigned(&auth),
        ))
        .to_bytes();
    auth.detached_signature_sha256 = sha256_hex(&signature);
    (encode_installation(&auth), signature)
}

#[cfg(test)]
mod canonical_goldens {
    use ed25519_dalek::{Signer as _, SigningKey};
    use sha2::{Digest as _, Sha256};

    use super::{
        BootstrapRecord, InstallationAuthorization, InstalledPolicy, MAX_RECORD,
        MAX_REGISTRY_RECORDS, MAX_REGISTRY_SIGNATURES, MAX_REGISTRY_TOTAL_BYTES,
        MAX_REGISTRY_TRANSITIONS, REGISTRY_INVENTORY_DOMAIN, RegistryRecord, append_final_field,
        decode_exact, encode_bootstrap, encode_installation, encode_registry_record,
        signature_preimage, validate_installation_time_shape, verify_bootstrap, verify_signature,
    };

    macro_rules! bootstrap_prefix {
        () => {
            concat!(
                "{\n",
                "  \"schemaVersion\": \"openspell.synthetic-preparation-proof-bootstrap-record.v1\",\n",
                "  \"registryGeneration\": 0,\n",
                "  \"previousRegistryRecordSha256\": \"8a8a886ffc13da0bbb70e73d66268c16ad36ba5a23b00bb7e5bb911e01a10345\",\n",
                "  \"currentPolicySha256\": \"692216120478fce4caa82e569767ec872b36ec7fccbf4c9430eb7f11e433fcdb\",\n",
                "  \"currentManifestSha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n",
                "  \"bootstrapVerifierIdentitySha256\": \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\n",
                "  \"bootstrapLockIdentitySha256\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\n",
                "  \"sourceRevision\": \"0000000000000000000000000000000000000000\",\n",
                "  \"activatedAt\": \"2026-09-04T00:00:00.000Z\",\n",
                "  \"issuerPublicKeySha256\": \"10ba682c8ad13513971e8b56881aab8bd702bb807796eca81932c735a94d6e6d\""
            )
        };
    }

    macro_rules! installation_prefix {
        () => {
            concat!(
                "{\n",
                "  \"schemaVersion\": \"openspell.preparation-state-root-installation-authorization.v1\",\n",
                "  \"installationAuthorizationNonce\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n",
                "  \"sourceRevision\": \"0000000000000000000000000000000000000000\",\n",
                "  \"proofBootstrapRegistrySha256\": \"f1188ca2e827f350c45643c4a1e203a4c101791c0c577383720a1671bf450621\",\n",
                "  \"proofBootstrapVerifierIdentitySha256\": \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\n",
                "  \"proofBootstrapManifestSha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n",
                "  \"proofBootstrapLockIdentitySha256\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\n",
                "  \"boundStateRootIdentitySha256\": \"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\n",
                "  \"preparationPolicySha256\": \"692216120478fce4caa82e569767ec872b36ec7fccbf4c9430eb7f11e433fcdb\",\n",
                "  \"privilegedExecutablePolicySha256\": \"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\n",
                "  \"privilegedExecutablePolicyGeneration\": 0,\n",
                "  \"registrySignerPublicKeySha256\": \"790901b82a89fe505b5f98e2b7bf28e3a74f9a40f1a561c9d353f85f61cc36a2\",\n",
                "  \"trustedClockProviderSha256\": \"bb4c27585d7712adb4a8d5c0973a3123a42a67995964b0510ffdb21d9e1cadb2\",\n",
                "  \"activeFormat\": \"preparation_v2\",\n",
                "  \"activeJournalName\": \"PREPARATION_JOURNAL_V2\",\n",
                "  \"targetClass\": \"synthetic_only\",\n",
                "  \"externalCapability\": false,\n",
                "  \"liveAdapterAllowed\": false,\n",
                "  \"maximumDurationSeconds\": 300,\n",
                "  \"issuedAt\": \"2026-09-04T00:00:00.000Z\",\n",
                "  \"expiresAt\": \"2026-09-04T00:05:00.000Z\",\n",
                "  \"authenticatedOperatorIdentitySha256\": \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\n",
                "  \"osAuthenticationSessionSha256\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\n",
                "  \"authenticatedAt\": \"2026-09-04T00:00:00.000Z\",\n",
                "  \"issuerPublicKeySha256\": \"1325b850c2871916eae203f0efc3c8987f64e5e3cdb27679e6d1fa97808357e6\""
            )
        };
    }

    macro_rules! registry_prefix {
        () => {
            concat!(
                "{\n",
                "  \"schemaVersion\": \"openspell.hosted-migration-authority-registry.v1\",\n",
                "  \"registryGeneration\": 1,\n",
                "  \"previousRegistryRecordSha256\": \"dfe1ba8e9380db530e4d8847e8169cf919455cb25df9734bdab34def9ba8f0c7\",\n",
                "  \"activeFormat\": \"preparation_v2\",\n",
                "  \"activeJournalName\": \"PREPARATION_JOURNAL_V2\",\n",
                "  \"activeJournalIdentitySha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n",
                "  \"authoritySuperLockIdentitySha256\": \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\n",
                "  \"installationAuthorizationSha256\": \"11095d6bff6edaca34a84752c67991becd91f2f00516aaaf2b984108097417d5\",\n",
                "  \"installationAuthorizationSignatureSha256\": \"3f59d9af5ff70a705aa20a0b3be6a23aa18519ca20d439029702e3641b4c1fb5\",\n",
                "  \"boundStateRootIdentitySha256\": \"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\n",
                "  \"preparationPolicySha256\": \"692216120478fce4caa82e569767ec872b36ec7fccbf4c9430eb7f11e433fcdb\",\n",
                "  \"proofBootstrapRegistrySha256\": \"f1188ca2e827f350c45643c4a1e203a4c101791c0c577383720a1671bf450621\",\n",
                "  \"proofBootstrapVerifierIdentitySha256\": \"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\n",
                "  \"proofBootstrapManifestSha256\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\n",
                "  \"proofBootstrapLockIdentitySha256\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\n",
                "  \"sourceRevision\": \"0000000000000000000000000000000000000000\",\n",
                "  \"privilegedExecutablePolicySha256\": \"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\n",
                "  \"privilegedExecutablePolicyGeneration\": 0,\n",
                "  \"activeTargetFingerprint\": null,\n",
                "  \"activeTargetGeneration\": 0,\n",
                "  \"otherFormatDisposition\": \"absent\",\n",
                "  \"otherFormatTerminalTransitionSha256\": null,\n",
                "  \"installedAt\": \"2026-09-04T00:00:00.000Z\",\n",
                "  \"issuerPublicKeySha256\": \"790901b82a89fe505b5f98e2b7bf28e3a74f9a40f1a561c9d353f85f61cc36a2\""
            )
        };
    }

    const BOOTSTRAP_UNSIGNED: &[u8] = concat!(bootstrap_prefix!(), "\n}\n").as_bytes();
    const BOOTSTRAP_COMPLETE: &[u8] = concat!(
        bootstrap_prefix!(),
        ",\n  \"detachedSignatureSha256\": \"ba9ccf490260647265116c16ec5954d0bcc591c69af3be837f08ad2806289c43\"\n}\n"
    )
    .as_bytes();
    const INSTALLATION_UNSIGNED: &[u8] = concat!(installation_prefix!(), "\n}\n").as_bytes();
    const INSTALLATION_COMPLETE: &[u8] = concat!(
        installation_prefix!(),
        ",\n  \"detachedSignatureSha256\": \"3f59d9af5ff70a705aa20a0b3be6a23aa18519ca20d439029702e3641b4c1fb5\"\n}\n"
    )
    .as_bytes();
    const REGISTRY_UNSIGNED: &[u8] = concat!(registry_prefix!(), "\n}\n").as_bytes();
    const REGISTRY_COMPLETE: &[u8] = concat!(
        registry_prefix!(),
        ",\n  \"detachedSignatureSha256\": \"56e5e5e1b3237a9a5b30f7cb9bb6841be0f440b0c93ed2b54a61e6360313660c\"\n}\n"
    )
    .as_bytes();

    const UNSIGNED: &[u8] = concat!(
        "{\n",
        "  \"schemaVersion\": \"openspell.synthetic-canonical-golden.v1\",\n",
        "  \"generation\": 1\n",
        "}\n"
    )
    .as_bytes();

    #[test]
    fn final_field_bytes_match_an_independent_literal() {
        assert_eq!(
            append_final_field(UNSIGNED, "detachedSignatureSha256", "ab"),
            concat!(
                "{\n",
                "  \"schemaVersion\": \"openspell.synthetic-canonical-golden.v1\",\n",
                "  \"generation\": 1,\n",
                "  \"detachedSignatureSha256\": \"ab\"\n",
                "}\n"
            )
            .as_bytes()
        );
    }

    #[test]
    fn signature_preimage_matches_an_independent_signature_golden() {
        let key = SigningKey::from_bytes(&[0x5a; 32]);
        let signature = key.sign(&signature_preimage(
            "openspell.synthetic-canonical-golden-signature.v1",
            UNSIGNED,
        ));
        assert_eq!(
            hex::encode(signature.to_bytes()),
            concat!(
                "e9c1bcac38e6bf6a39344333b497f1d73afe371ab90799a11181a0bf266e06ba9",
                "a600a68b190273b36c0f6fca0c69ef16f0e1acb06b2ff81f88981b593023d00"
            )
        );
    }

    #[test]
    fn three_linked_real_schema_vectors_are_independent_and_exact() {
        let bootstrap_signature = signature(concat!(
            "c955d0b57fbd9cb2b85ab852a3cd783997f1da179b75e284baa5708279f5a8aa",
            "58b2e5e1e03b5c06df7c28e903117775615eedaa6f44367e021afeb3940ffc04"
        ));
        let installation_signature = signature(concat!(
            "51341bab0780d1780c8a4cc66bf6620c0a05864939e0041259efa46975a7f1072",
            "2fde0ce51a8001a6054a8d62cf3ddf6ad85ec5c24b89b47a94b8f90318f7006"
        ));
        let registry_signature = signature(concat!(
            "6e771ab49ca9cc4b76d40e99031a2f60bb1b7c76c6eca77790e0c4696835cfb8",
            "b58f934260e21d23aebb0e0aade3de6309111a5e188aaf575447f5dbb1e89205"
        ));
        let bootstrap_key = key("d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737");
        let installation_key =
            key("a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f0");
        let registry_key = key("0d7550754e0800a5d237eef5826035766b9b3e5a15868a940ab289958788e3b0");

        assert_vector(
            BOOTSTRAP_UNSIGNED,
            810,
            "bda409ee4fc6c11d9d9d081afdabb147afea50b5350726a9793b5815d69284d1",
            &bootstrap_signature,
            "ba9ccf490260647265116c16ec5954d0bcc591c69af3be837f08ad2806289c43",
            BOOTSTRAP_COMPLETE,
            907,
            "f1188ca2e827f350c45643c4a1e203a4c101791c0c577383720a1671bf450621",
        );
        let bootstrap: BootstrapRecord =
            decode_exact(BOOTSTRAP_COMPLETE, encode_bootstrap).expect("bootstrap vector");
        assert_eq!(encode_bootstrap(&bootstrap), BOOTSTRAP_COMPLETE);
        let policy = InstalledPolicy {
            source_revision: "0000000000000000000000000000000000000000".into(),
            bootstrap_verifier_sha256:
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            bootstrap_manifest_sha256:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            bootstrap_key,
            root_issuer_key: installation_key,
            registry_key,
            executable_policy_sha256:
                "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into(),
        };
        verify_bootstrap(
            &bootstrap,
            &bootstrap_signature,
            &policy,
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        )
        .expect("bootstrap signature and bindings");

        assert_vector(
            INSTALLATION_UNSIGNED,
            1_885,
            "85cf01c45ae519e0a1bc3113de2378e29ecc8a13f4f5d5415c7e6f7e38e5e268",
            &installation_signature,
            "3f59d9af5ff70a705aa20a0b3be6a23aa18519ca20d439029702e3641b4c1fb5",
            INSTALLATION_COMPLETE,
            1_982,
            "11095d6bff6edaca34a84752c67991becd91f2f00516aaaf2b984108097417d5",
        );
        let installation: InstallationAuthorization =
            decode_exact(INSTALLATION_COMPLETE, encode_installation).expect("installation vector");
        assert_eq!(encode_installation(&installation), INSTALLATION_COMPLETE);
        validate_installation_time_shape(&installation).expect("installation time shape");
        verify_signature(
            "openspell.preparation-state-root-installation-authorization-signature.v1",
            INSTALLATION_UNSIGNED,
            &installation_signature,
            &installation_key,
        )
        .expect("installation signature");

        assert_vector(
            REGISTRY_UNSIGNED,
            1_839,
            "5d3cabff30af686bce2060824ec0c81e99b36665b110643fdeca8a9150bf015f",
            &registry_signature,
            "56e5e5e1b3237a9a5b30f7cb9bb6841be0f440b0c93ed2b54a61e6360313660c",
            REGISTRY_COMPLETE,
            1_936,
            "add2e665c50db45e9257e624e3f725787bad2df97c9468c3492f5e8985aa6dbd",
        );
        let registry: RegistryRecord =
            decode_exact(REGISTRY_COMPLETE, encode_registry_record).expect("registry vector");
        assert_eq!(encode_registry_record(&registry), REGISTRY_COMPLETE);
        assert_eq!(
            registry.installation_authorization_sha256,
            hex::encode(Sha256::digest(INSTALLATION_COMPLETE))
        );
        assert_eq!(
            registry.installation_authorization_signature_sha256,
            hex::encode(Sha256::digest(installation_signature))
        );
        assert_eq!(
            registry.proof_bootstrap_registry_sha256,
            hex::encode(Sha256::digest(BOOTSTRAP_COMPLETE))
        );
        verify_signature(
            "openspell.hosted-migration-authority-registry-signature.v1",
            REGISTRY_UNSIGNED,
            &registry_signature,
            &registry_key,
        )
        .expect("registry signature");

        for (complete, decoder) in [
            (
                BOOTSTRAP_COMPLETE,
                decode_bootstrap_vector as fn(&[u8]) -> bool,
            ),
            (INSTALLATION_COMPLETE, decode_installation_vector),
            (REGISTRY_COMPLETE, decode_registry_vector),
        ] {
            let mut trailing = complete.to_vec();
            trailing.push(b' ');
            assert!(!decoder(&trailing));
            let mut unknown = complete.to_vec();
            unknown.splice(2..2, b"  \"unknown\": 0,\n".iter().copied());
            assert!(!decoder(&unknown));
            let mut lines: Vec<&[u8]> = complete.split_inclusive(|byte| *byte == b'\n').collect();
            lines.swap(1, 2);
            assert!(!decoder(&lines.concat()));
        }
        for (domain, unsigned, signature, key) in [
            (
                "openspell.synthetic-preparation-proof-bootstrap-signature.v1",
                BOOTSTRAP_UNSIGNED,
                &bootstrap_signature,
                &bootstrap_key,
            ),
            (
                "openspell.preparation-state-root-installation-authorization-signature.v1",
                INSTALLATION_UNSIGNED,
                &installation_signature,
                &installation_key,
            ),
            (
                "openspell.hosted-migration-authority-registry-signature.v1",
                REGISTRY_UNSIGNED,
                &registry_signature,
                &registry_key,
            ),
        ] {
            let mut changed_message = unsigned.to_vec();
            changed_message[2] ^= 1;
            assert!(verify_signature(domain, &changed_message, signature, key).is_err());
            let mut changed_signature = *signature;
            changed_signature[0] ^= 1;
            assert!(verify_signature(domain, unsigned, &changed_signature, key).is_err());
            assert!(verify_signature("openspell.wrong.v1", unsigned, signature, key).is_err());
            assert!(verify_signature(domain, unsigned, signature, &[0; 32]).is_err());
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn assert_vector(
        unsigned: &[u8],
        unsigned_len: usize,
        unsigned_sha: &str,
        signature: &[u8; 64],
        signature_sha: &str,
        complete: &[u8],
        complete_len: usize,
        complete_sha: &str,
    ) {
        assert_eq!(unsigned.len(), unsigned_len);
        assert_eq!(hex::encode(Sha256::digest(unsigned)), unsigned_sha);
        assert_eq!(hex::encode(Sha256::digest(signature)), signature_sha);
        assert_eq!(complete.len(), complete_len);
        assert_eq!(hex::encode(Sha256::digest(complete)), complete_sha);
    }

    fn signature(value: &str) -> [u8; 64] {
        hex::decode(value)
            .expect("signature hex")
            .try_into()
            .expect("signature length")
    }

    fn key(value: &str) -> [u8; 32] {
        hex::decode(value)
            .expect("key hex")
            .try_into()
            .expect("key length")
    }

    fn decode_bootstrap_vector(bytes: &[u8]) -> bool {
        decode_exact::<BootstrapRecord>(bytes, encode_bootstrap).is_ok()
    }

    fn decode_installation_vector(bytes: &[u8]) -> bool {
        decode_exact::<InstallationAuthorization>(bytes, encode_installation).is_ok()
    }

    fn decode_registry_vector(bytes: &[u8]) -> bool {
        decode_exact::<RegistryRecord>(bytes, encode_registry_record).is_ok()
    }

    #[test]
    fn registry_inventory_namespace_and_limits_are_exact() {
        assert_eq!(
            REGISTRY_INVENTORY_DOMAIN,
            b"openspell.hosted-migration-authority-registry-inventory.v1\n"
        );
        assert_eq!(MAX_REGISTRY_TRANSITIONS, 2);
        assert_eq!(MAX_REGISTRY_RECORDS, 3);
        assert_eq!(MAX_REGISTRY_SIGNATURES, 3);
        assert_eq!(MAX_RECORD, 16_384);
        assert_eq!(MAX_REGISTRY_TOTAL_BYTES, 262_144);
    }
}
