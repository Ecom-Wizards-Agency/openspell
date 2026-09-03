use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::mem::MaybeUninit;

use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, RawDir, RenameFlags, ResolveFlags, StatxFlags, fchmod, fsync,
    makedev, openat, openat2, renameat_with, statx,
};
use serde::Serialize;

use crate::archive::{ArchiveRefusal, verify_assets};
use crate::canonical::{Digest32, canonical_json, now_utc_milliseconds, sha256};
use crate::policy::{EvidenceClass, EvidenceMarker, OwnerPolicy};

const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK);
const CREATE_FLAGS: OFlags = OFlags::RDWR
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CREATE)
    .union(OFlags::EXCL);
const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
const REQUIRED_STATX: StatxFlags = StatxFlags::BASIC_STATS.union(StatxFlags::MNT_ID);
const CONSUMED_NAME: &str = ".RETENTION-CONSUMED";
const INVENTORY_NAME: &str = "SEALED-INVENTORY.json";
const MAX_ANCESTORS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProvenanceRefusal {
    SourceUnavailable,
    SourceMismatch,
    ArchiveRejected,
    RetentionUncertain,
}

impl From<ArchiveRefusal> for ProvenanceRefusal {
    fn from(_: ArchiveRefusal) -> Self {
        Self::ArchiveRejected
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    dev_major: u32,
    dev_minor: u32,
    inode: u64,
    mode: u16,
    uid: u32,
    gid: u32,
    links: u32,
    size: u64,
    mount_id: u64,
    ctime_sec: i64,
    ctime_nsec: u32,
    mtime_sec: i64,
    mtime_nsec: u32,
}

impl Identity {
    fn read(file: &File) -> Result<Self, ProvenanceRefusal> {
        let stat = statx(file, c"", AtFlags::EMPTY_PATH, REQUIRED_STATX)
            .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
        if stat.stx_mask & REQUIRED_STATX.bits() != REQUIRED_STATX.bits() {
            return Err(ProvenanceRefusal::SourceUnavailable);
        }
        Ok(Self {
            dev_major: stat.stx_dev_major,
            dev_minor: stat.stx_dev_minor,
            inode: stat.stx_ino,
            mode: stat.stx_mode,
            uid: stat.stx_uid,
            gid: stat.stx_gid,
            links: stat.stx_nlink,
            size: stat.stx_size,
            mount_id: stat.stx_mnt_id,
            ctime_sec: stat.stx_ctime.tv_sec,
            ctime_nsec: stat.stx_ctime.tv_nsec,
            mtime_sec: stat.stx_mtime.tv_sec,
            mtime_nsec: stat.stx_mtime.tv_nsec,
        })
    }

    fn is_directory(self) -> bool {
        self.mode & 0o170_000 == 0o040_000
    }

    fn is_regular(self) -> bool {
        self.mode & 0o170_000 == 0o100_000
    }

    fn permissions(self) -> u32 {
        u32::from(self.mode) & 0o7_777
    }

    fn same_object(self, other: Self) -> bool {
        self.dev_major == other.dev_major
            && self.dev_minor == other.dev_minor
            && self.inode == other.inode
            && self.mount_id == other.mount_id
    }
}

pub(crate) struct RootAnchoredPair<C: EvidenceClass> {
    filesystem_root: File,
    ancestors: Vec<File>,
    intake_root: File,
    checksums: File,
    archive: File,
    root_identity: Identity,
    ancestor_identities: Vec<Identity>,
    intake_identity: Identity,
    checksums_identity: Identity,
    archive_identity: Identity,
    acquired_at: String,
    marker: EvidenceMarker<C>,
}

impl<C: EvidenceClass> RootAnchoredPair<C> {
    pub(crate) fn from_open_descriptors(
        filesystem_root: File,
        ancestors: Vec<File>,
        intake_root: File,
        checksums: File,
        archive: File,
    ) -> Result<Self, ProvenanceRefusal> {
        if ancestors.is_empty() || ancestors.len() > MAX_ANCESTORS {
            return Err(ProvenanceRefusal::SourceMismatch);
        }
        let policy = C::policy();
        let root_identity = Identity::read(&filesystem_root)?;
        let expected_owner = match policy.owner {
            OwnerPolicy::Root => (0, 0),
            #[cfg(test)]
            OwnerPolicy::RootDescriptor => (root_identity.uid, root_identity.gid),
        };
        verify_directory(root_identity, expected_owner)?;
        if matches!(policy.owner, OwnerPolicy::Root) {
            verify_filesystem_root(&filesystem_root)?;
        }

        let ancestor_identities = ancestors
            .iter()
            .map(Identity::read)
            .collect::<Result<Vec<_>, _>>()?;
        for identity in &ancestor_identities {
            verify_directory(*identity, expected_owner)?;
            if identity.mount_id != root_identity.mount_id {
                return Err(ProvenanceRefusal::SourceMismatch);
            }
        }
        verify_ancestor_chain(&filesystem_root, &ancestors)?;

        let intake_identity = Identity::read(&intake_root)?;
        verify_directory(intake_identity, expected_owner)?;
        if intake_identity.mount_id != root_identity.mount_id
            || !intake_identity.same_object(
                *ancestor_identities
                    .last()
                    .ok_or(ProvenanceRefusal::SourceMismatch)?,
            )
        {
            return Err(ProvenanceRefusal::SourceMismatch);
        }

        let checksums_identity = Identity::read(&checksums)?;
        let archive_identity = Identity::read(&archive)?;
        verify_source_file(checksums_identity, expected_owner, policy.checksums.size)?;
        verify_source_file(archive_identity, expected_owner, policy.archive.size)?;
        verify_named_descriptor(
            &intake_root,
            policy.checksums.name,
            &checksums,
            checksums_identity,
        )?;
        verify_named_descriptor(
            &intake_root,
            policy.archive.name,
            &archive,
            archive_identity,
        )?;
        verify_intake_inventory(&intake_root, &policy)?;
        let acquired_at =
            now_utc_milliseconds().map_err(|_| ProvenanceRefusal::SourceUnavailable)?;

        Ok(Self {
            filesystem_root,
            ancestors,
            intake_root,
            checksums,
            archive,
            root_identity,
            ancestor_identities,
            intake_identity,
            checksums_identity,
            archive_identity,
            acquired_at,
            marker: EvidenceMarker::new(),
        })
    }

    fn revalidate_tree(&self) -> Result<(), ProvenanceRefusal> {
        if Identity::read(&self.filesystem_root)? != self.root_identity
            || Identity::read(&self.intake_root)? != self.intake_identity
            || Identity::read(&self.checksums)? != self.checksums_identity
            || Identity::read(&self.archive)? != self.archive_identity
        {
            return Err(ProvenanceRefusal::SourceMismatch);
        }
        for (descriptor, expected) in self.ancestors.iter().zip(&self.ancestor_identities) {
            if Identity::read(descriptor)? != *expected {
                return Err(ProvenanceRefusal::SourceMismatch);
            }
        }
        verify_ancestor_chain(&self.filesystem_root, &self.ancestors)?;
        let policy = C::policy();
        verify_named_descriptor(
            &self.intake_root,
            policy.checksums.name,
            &self.checksums,
            self.checksums_identity,
        )?;
        verify_named_descriptor(
            &self.intake_root,
            policy.archive.name,
            &self.archive,
            self.archive_identity,
        )?;
        verify_intake_inventory(&self.intake_root, &policy)
    }
}

pub(crate) struct FreshRetainedRoot {
    root: File,
    identity: Identity,
}

impl FreshRetainedRoot {
    pub(crate) fn from_open_descriptor(root: File) -> Result<Self, ProvenanceRefusal> {
        let identity = Identity::read(&root)?;
        if !identity.is_directory()
            || identity.permissions() & 0o022 != 0
            || identity.links < 2
            || !directory_names(&root, 0)?.is_empty()
        {
            return Err(ProvenanceRefusal::RetentionUncertain);
        }
        Ok(Self { root, identity })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Conservation {
    pub(crate) offered_count: u64,
    pub(crate) parsed_count: u64,
    pub(crate) published_count: u64,
    pub(crate) reopened_count: u64,
    pub(crate) offered_bytes: u64,
    pub(crate) parsed_bytes: u64,
    pub(crate) published_bytes: u64,
    pub(crate) reopened_bytes: u64,
    pub(crate) parsed_digests: [Digest32; 2],
    pub(crate) published_digests: [Digest32; 2],
    pub(crate) reopened_digests: [Digest32; 2],
}

pub(crate) struct RetainedRelease<C: EvidenceClass> {
    root: File,
    retained: [File; 2],
    inventory: File,
    root_identity: Identity,
    retained_identities: [Identity; 2],
    inventory_identity: Identity,
    inventory_digest: Digest32,
    source_evidence_bytes: Vec<u8>,
    source_evidence_digest: Digest32,
    conservation: Conservation,
    marker: EvidenceMarker<C>,
}

impl<C: EvidenceClass> RetainedRelease<C> {
    pub(crate) fn conservation(&self) -> &Conservation {
        &self.conservation
    }

    pub(crate) fn root(&self) -> &File {
        &self.root
    }

    pub(crate) fn retained(&self) -> &[File; 2] {
        &self.retained
    }

    pub(crate) fn inventory(&self) -> &File {
        &self.inventory
    }

    pub(crate) fn source_evidence_bytes(&self) -> &[u8] {
        &self.source_evidence_bytes
    }

    pub(crate) fn source_evidence_digest(&self) -> Digest32 {
        self.source_evidence_digest
    }

    pub(crate) fn revalidate_for_runtime(&self) -> Result<(), ProvenanceRefusal> {
        let policy = C::policy();
        let owner = (self.root_identity.uid, self.root_identity.gid);
        if Identity::read(&self.root)? != self.root_identity {
            return Err(ProvenanceRefusal::RetentionUncertain);
        }
        for ((file, expected), entry) in self
            .retained
            .iter()
            .zip(self.retained_identities)
            .zip(policy.entries.iter())
        {
            verify_retained_descriptor(
                &self.root,
                entry.name,
                file,
                expected,
                entry.size,
                entry.digest,
                retained_mode(entry.mode),
                owner,
            )?;
        }
        verify_retained_descriptor(
            &self.root,
            INVENTORY_NAME,
            &self.inventory,
            self.inventory_identity,
            self.inventory_identity.size,
            self.inventory_digest,
            0o444,
            owner,
        )?;
        let mut expected_names = vec![
            policy.entries[0].name.to_owned(),
            policy.entries[1].name.to_owned(),
            INVENTORY_NAME.to_owned(),
        ];
        expected_names.sort_unstable();
        if directory_names(&self.root, expected_names.len())? != expected_names
            || Identity::read(&self.root)? != self.root_identity
        {
            return Err(ProvenanceRefusal::RetentionUncertain);
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct Inventory<'a> {
    schema: &'static str,
    evidence_class: &'static str,
    repository: &'a str,
    release: &'a str,
    source_archive_sha256: String,
    source_evidence: &'a SourceEvidence,
    source_evidence_sha256: String,
    entries: [InventoryEntry<'a>; 2],
}

#[derive(Serialize)]
struct InventoryEntry<'a> {
    name: &'a str,
    bytes: u64,
    sha256: String,
    mode: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceEvidence {
    schema_version: &'static str,
    repository: &'static str,
    release_tag: &'static str,
    checksums_asset_name: &'static str,
    checksums_asset_bytes: u64,
    checksums_asset_sha256: String,
    archive_asset_name: &'static str,
    archive_bytes: u64,
    archive_sha256: String,
    archive_entries: [&'static str; 2],
    front_controller_entry: &'static str,
    front_controller_bytes: u64,
    front_controller_sha256: String,
    delegate_entry: &'static str,
    delegate_bytes: u64,
    delegate_sha256: String,
    source_root_device: u64,
    source_root_inode: u64,
    source_root_mode: String,
    source_root_uid: u32,
    source_root_gid: u32,
    ancestor_walk_sha256: String,
    acquired_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AncestorWalk {
    schema_version: &'static str,
    components: Vec<AncestorComponent>,
}

#[derive(Serialize)]
struct AncestorComponent {
    device: u64,
    inode: u64,
    mode: String,
    uid: u32,
    gid: u32,
}

fn source_evidence<C: EvidenceClass>(
    incoming: &RootAnchoredPair<C>,
    policy: &crate::policy::ReleasePolicy,
) -> Result<(SourceEvidence, Vec<u8>, Digest32), ProvenanceRefusal> {
    if policy.entries[0].name >= policy.entries[1].name {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    let components = std::iter::once(incoming.root_identity)
        .chain(incoming.ancestor_identities.iter().copied())
        .map(|identity| AncestorComponent {
            device: makedev(identity.dev_major, identity.dev_minor),
            inode: identity.inode,
            mode: format!("{:04o}", identity.permissions()),
            uid: identity.uid,
            gid: identity.gid,
        })
        .collect();
    let ancestor_walk = canonical_json(&AncestorWalk {
        schema_version: "openspell.source-ancestor-walk.v1",
        components,
    })
    .map_err(|_| ProvenanceRefusal::SourceMismatch)?;
    let evidence = SourceEvidence {
        schema_version: C::source_schema(),
        repository: policy.repository,
        release_tag: policy.release,
        checksums_asset_name: policy.checksums.name,
        checksums_asset_bytes: policy.checksums.size,
        checksums_asset_sha256: policy.checksums.digest.to_hex(),
        archive_asset_name: policy.archive.name,
        archive_bytes: policy.archive.size,
        archive_sha256: policy.archive.digest.to_hex(),
        archive_entries: [policy.entries[0].name, policy.entries[1].name],
        front_controller_entry: policy.entries[0].name,
        front_controller_bytes: policy.entries[0].size,
        front_controller_sha256: policy.entries[0].digest.to_hex(),
        delegate_entry: policy.entries[1].name,
        delegate_bytes: policy.entries[1].size,
        delegate_sha256: policy.entries[1].digest.to_hex(),
        source_root_device: makedev(
            incoming.intake_identity.dev_major,
            incoming.intake_identity.dev_minor,
        ),
        source_root_inode: incoming.intake_identity.inode,
        source_root_mode: format!("{:04o}", incoming.intake_identity.permissions()),
        source_root_uid: incoming.intake_identity.uid,
        source_root_gid: incoming.intake_identity.gid,
        ancestor_walk_sha256: sha256(&ancestor_walk).to_hex(),
        acquired_at: incoming.acquired_at.clone(),
    };
    let bytes = canonical_json(&evidence).map_err(|_| ProvenanceRefusal::SourceMismatch)?;
    let digest = sha256(&bytes);
    Ok((evidence, bytes, digest))
}

pub(crate) fn seal_release<C: EvidenceClass>(
    incoming: RootAnchoredPair<C>,
    destination: FreshRetainedRoot,
) -> Result<RetainedRelease<C>, ProvenanceRefusal> {
    let policy = C::policy();
    verify_destination(&destination)?;
    let destination_owner = (destination.identity.uid, destination.identity.gid);
    let required_destination_owner = match policy.owner {
        OwnerPolicy::Root => (0, 0),
        #[cfg(test)]
        OwnerPolicy::RootDescriptor => (incoming.root_identity.uid, incoming.root_identity.gid),
    };
    if destination_owner != required_destination_owner {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    let mut inventory = reserve_destination(&destination.root, destination_owner)?;
    fault(TestFaultPoint::DestinationConsumed)?;

    incoming.revalidate_tree()?;
    let checksums = read_exact_stable(
        &incoming.checksums,
        incoming.checksums_identity,
        C::policy().checksums.size,
    )?;
    incoming.revalidate_tree()?;
    let archive_bytes = read_exact_stable(
        &incoming.archive,
        incoming.archive_identity,
        C::policy().archive.size,
    )?;
    incoming.revalidate_tree()?;

    let parsed = verify_assets(&checksums, &archive_bytes, &policy)?;
    let (source_evidence, source_evidence_bytes, source_evidence_digest) =
        source_evidence(&incoming, &policy)?;

    let mut published = Vec::with_capacity(2);
    for (ordinal, entry) in parsed.entries.iter().enumerate() {
        let file = create_and_sync(
            &destination.root,
            entry.name,
            &entry.bytes,
            retained_mode(entry.mode),
            destination_owner,
            ordinal,
        )?;
        fault(TestFaultPoint::EntrySynced(ordinal))?;
        published.push(file);
    }
    fault(TestFaultPoint::BeforeEntriesDirectorySync)?;
    fsync(&destination.root).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::EntriesDirectorySynced)?;

    let inventory_bytes = canonical_json(&Inventory {
        schema: "openspell.hosted-migration-retained-release.v1",
        evidence_class: C::label(),
        repository: policy.repository,
        release: policy.release,
        source_archive_sha256: policy.archive.digest.to_hex(),
        source_evidence: &source_evidence,
        source_evidence_sha256: source_evidence_digest.to_hex(),
        entries: [
            InventoryEntry {
                name: policy.entries[0].name,
                bytes: policy.entries[0].size,
                sha256: policy.entries[0].digest.to_hex(),
                mode: retained_mode(policy.entries[0].mode),
            },
            InventoryEntry {
                name: policy.entries[1].name,
                bytes: policy.entries[1].size,
                sha256: policy.entries[1].digest.to_hex(),
                mode: retained_mode(policy.entries[1].mode),
            },
        ],
    })
    .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::BeforeInventory)?;
    finish_reserved_inventory(&mut inventory, &inventory_bytes, destination_owner)?;
    fault(TestFaultPoint::InventorySynced)?;
    renameat_with(
        &destination.root,
        CONSUMED_NAME,
        &destination.root,
        INVENTORY_NAME,
        RenameFlags::NOREPLACE,
    )
    .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::BeforeInventoryDirectorySync)?;
    fsync(&destination.root).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::InventoryDirectorySynced)?;

    let published_identities = [
        Identity::read(&published[0])?,
        Identity::read(&published[1])?,
    ];
    let inventory_identity = Identity::read(&inventory)?;
    let final_root_identity = verify_destination_metadata(&destination)?;

    let mut expected_names = vec![
        policy.entries[0].name.to_owned(),
        policy.entries[1].name.to_owned(),
        INVENTORY_NAME.to_owned(),
    ];
    expected_names.sort_unstable();
    if directory_names(&destination.root, expected_names.len())? != expected_names {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }

    let reopened = [
        reopen_exact(
            &destination.root,
            &policy.entries[0],
            destination_owner,
            published_identities[0],
        )?,
        reopen_exact(
            &destination.root,
            &policy.entries[1],
            destination_owner,
            published_identities[1],
        )?,
    ];
    let reopened_inventory = reopen_bytes(
        &destination.root,
        INVENTORY_NAME,
        inventory_bytes.len() as u64,
        sha256(&inventory_bytes),
        0o444,
        destination_owner,
        inventory_identity,
    )?;
    fault(TestFaultPoint::Reopened)?;

    if Identity::read(&destination.root)? != final_root_identity
        || directory_names(&destination.root, expected_names.len())? != expected_names
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    fault(TestFaultPoint::BeforeFinalDirectorySync)?;
    fsync(&destination.root).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::FinalDirectorySynced)?;

    let parsed_digests = [parsed.entries[0].digest, parsed.entries[1].digest];
    let published_digests = [digest_file(&published[0])?, digest_file(&published[1])?];
    let reopened_digests = [digest_file(&reopened[0])?, digest_file(&reopened[1])?];
    let published_bytes = file_sizes(&published)?;
    let reopened_bytes = file_sizes(&reopened)?;
    let conservation = Conservation {
        offered_count: 2,
        parsed_count: parsed.entries.len() as u64,
        published_count: published.len() as u64,
        reopened_count: reopened.len() as u64,
        offered_bytes: policy.entries[0].size + policy.entries[1].size,
        parsed_bytes: parsed.payload_bytes,
        published_bytes,
        reopened_bytes,
        parsed_digests,
        published_digests,
        reopened_digests,
    };
    if conservation.offered_count != conservation.parsed_count
        || conservation.parsed_count != conservation.published_count
        || conservation.published_count != conservation.reopened_count
        || conservation.offered_bytes != conservation.parsed_bytes
        || conservation.parsed_bytes != conservation.published_bytes
        || conservation.published_bytes != conservation.reopened_bytes
        || conservation.parsed_digests != conservation.published_digests
        || conservation.published_digests != conservation.reopened_digests
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }

    drop(published);
    drop(inventory);
    Ok(RetainedRelease {
        root: destination.root,
        retained: reopened,
        inventory: reopened_inventory,
        root_identity: final_root_identity,
        retained_identities: published_identities,
        inventory_identity,
        inventory_digest: sha256(&inventory_bytes),
        source_evidence_bytes,
        source_evidence_digest,
        conservation,
        marker: incoming.marker,
    })
}

fn verify_directory(identity: Identity, owner: (u32, u32)) -> Result<(), ProvenanceRefusal> {
    if !identity.is_directory()
        || (identity.uid, identity.gid) != owner
        || identity.permissions() & 0o022 != 0
        || identity.links < 2
    {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(())
}

fn verify_source_file(
    identity: Identity,
    owner: (u32, u32),
    size: u64,
) -> Result<(), ProvenanceRefusal> {
    if !identity.is_regular()
        || (identity.uid, identity.gid) != owner
        || identity.permissions() & 0o022 != 0
        || identity.links != 1
        || identity.size != size
    {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(())
}

fn verify_ancestor_chain(root: &File, ancestors: &[File]) -> Result<(), ProvenanceRefusal> {
    let mut parent = root;
    for child in ancestors {
        let opened_parent: File = openat(child, c"..", DIRECTORY_FLAGS, Mode::empty())
            .map_err(|_| ProvenanceRefusal::SourceUnavailable)?
            .into();
        if !Identity::read(&opened_parent)?.same_object(Identity::read(parent)?) {
            return Err(ProvenanceRefusal::SourceMismatch);
        }
        parent = child;
    }
    Ok(())
}

fn verify_filesystem_root(root: &File) -> Result<(), ProvenanceRefusal> {
    let opened_parent: File = openat(root, c"..", DIRECTORY_FLAGS, Mode::empty())
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?
        .into();
    if !Identity::read(&opened_parent)?.same_object(Identity::read(root)?) {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn filesystem_root_is_self_parent_for_test(root: &File) -> bool {
    verify_filesystem_root(root).is_ok()
}

fn verify_named_descriptor(
    parent: &File,
    name: &str,
    supplied: &File,
    expected: Identity,
) -> Result<(), ProvenanceRefusal> {
    let opened: File = openat2(parent, name, READ_FLAGS, Mode::empty(), RESOLVE)
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?
        .into();
    let opened_identity = Identity::read(&opened)?;
    if opened_identity != expected || !opened_identity.same_object(Identity::read(supplied)?) {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn verify_retained_descriptor(
    root: &File,
    name: &str,
    supplied: &File,
    expected: Identity,
    size: u64,
    digest: Digest32,
    mode: u32,
    owner: (u32, u32),
) -> Result<(), ProvenanceRefusal> {
    let root_identity = Identity::read(root).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let supplied_before =
        Identity::read(supplied).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let opened: File = openat2(root, name, READ_FLAGS, Mode::empty(), RESOLVE)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?
        .into();
    let opened_before =
        Identity::read(&opened).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    if supplied_before != expected
        || opened_before != expected
        || expected.mount_id != root_identity.mount_id
        || !expected.is_regular()
        || expected.links != 1
        || expected.permissions() != mode
        || expected.size != size
        || (expected.uid, expected.gid) != owner
        || digest_file(&opened)? != digest
        || Identity::read(&opened).map_err(|_| ProvenanceRefusal::RetentionUncertain)? != expected
        || Identity::read(supplied).map_err(|_| ProvenanceRefusal::RetentionUncertain)? != expected
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(())
}

fn verify_intake_inventory(
    root: &File,
    policy: &crate::policy::ReleasePolicy,
) -> Result<(), ProvenanceRefusal> {
    let mut expected = vec![
        policy.checksums.name.to_owned(),
        policy.archive.name.to_owned(),
    ];
    expected.sort_unstable();
    if directory_names(root, expected.len()).map_err(|_| ProvenanceRefusal::SourceMismatch)?
        != expected
    {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(())
}

fn read_exact_stable(
    source: &File,
    expected: Identity,
    size: u64,
) -> Result<Vec<u8>, ProvenanceRefusal> {
    if Identity::read(source)? != expected || size != expected.size {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    let mut reader = source
        .try_clone()
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    let capacity = usize::try_from(size).map_err(|_| ProvenanceRefusal::SourceMismatch)?;
    let mut bytes = Vec::with_capacity(capacity);
    reader
        .take(size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    if bytes.len() != capacity || Identity::read(source)? != expected {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn read_exact_stable_with_mutation_for_test(
    source: &File,
    mutate: impl FnOnce(),
) -> Result<Vec<u8>, ProvenanceRefusal> {
    let expected = Identity::read(source)?;
    let mut reader = source
        .try_clone()
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    let capacity = usize::try_from(expected.size).map_err(|_| ProvenanceRefusal::SourceMismatch)?;
    let mut bytes = Vec::with_capacity(capacity);
    reader
        .take(expected.size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProvenanceRefusal::SourceUnavailable)?;
    mutate();
    if bytes.len() != capacity || Identity::read(source)? != expected {
        return Err(ProvenanceRefusal::SourceMismatch);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) fn source_descriptor_owner_matches_for_test(
    source: &File,
    expected_owner: (u32, u32),
) -> bool {
    Identity::read(source)
        .is_ok_and(|identity| verify_source_file(identity, expected_owner, identity.size).is_ok())
}

#[cfg(test)]
pub(crate) fn descriptors_share_mount_for_test(first: &File, second: &File) -> bool {
    Identity::read(first)
        .and_then(|left| Identity::read(second).map(|right| left.mount_id == right.mount_id))
        .unwrap_or(false)
}

fn verify_destination(destination: &FreshRetainedRoot) -> Result<(), ProvenanceRefusal> {
    verify_destination_metadata(destination)?;
    if !directory_names(&destination.root, 0)?.is_empty() {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(())
}

fn verify_destination_metadata(
    destination: &FreshRetainedRoot,
) -> Result<Identity, ProvenanceRefusal> {
    let now = Identity::read(&destination.root)?;
    if !now.is_directory()
        || !now.same_object(destination.identity)
        || now.mode != destination.identity.mode
        || now.uid != destination.identity.uid
        || now.gid != destination.identity.gid
        || now.links != destination.identity.links
        || now.mount_id != destination.identity.mount_id
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(now)
}

fn reserve_destination(root: &File, owner: (u32, u32)) -> Result<File, ProvenanceRefusal> {
    let owned = openat2(
        root,
        CONSUMED_NAME,
        CREATE_FLAGS,
        Mode::from_raw_mode(0o400),
        RESOLVE,
    )
    .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fchmod(&owned, Mode::from_raw_mode(0o400))
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let file: File = owned.into();
    fault(TestFaultPoint::BeforeDestinationSync)?;
    fsync(&file).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::BeforeDestinationDirectorySync)?;
    fsync(root).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let identity = Identity::read(&file)?;
    if !identity.is_regular()
        || identity.links != 1
        || identity.permissions() != 0o400
        || identity.size != 0
        || (identity.uid, identity.gid) != owner
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(file)
}

fn finish_reserved_inventory(
    file: &mut File,
    bytes: &[u8],
    owner: (u32, u32),
) -> Result<(), ProvenanceRefusal> {
    file.write_all(bytes)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    file.flush()
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fchmod(&*file, Mode::from_raw_mode(0o444))
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::BeforeInventorySync)?;
    fsync(&*file).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let identity = Identity::read(file)?;
    if !identity.is_regular()
        || identity.links != 1
        || identity.permissions() != 0o444
        || identity.size != bytes.len() as u64
        || (identity.uid, identity.gid) != owner
        || digest_file(file)? != sha256(bytes)
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(())
}

fn create_and_sync(
    root: &File,
    name: &str,
    bytes: &[u8],
    mode: u32,
    owner: (u32, u32),
    ordinal: usize,
) -> Result<File, ProvenanceRefusal> {
    let owned = openat2(root, name, CREATE_FLAGS, Mode::from_raw_mode(mode), RESOLVE)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fchmod(&owned, Mode::from_raw_mode(mode)).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let mut file: File = owned.into();
    file.write_all(bytes)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    file.flush()
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    fault(TestFaultPoint::BeforeEntrySync(ordinal))?;
    fsync(&file).map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let identity = Identity::read(&file)?;
    if !identity.is_regular()
        || identity.links != 1
        || identity.permissions() != mode
        || identity.size != bytes.len() as u64
        || (identity.uid, identity.gid) != owner
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(file)
}

fn reopen_exact(
    root: &File,
    policy: &crate::policy::EntryPolicy,
    owner: (u32, u32),
    expected_identity: Identity,
) -> Result<File, ProvenanceRefusal> {
    reopen_bytes(
        root,
        policy.name,
        policy.size,
        policy.digest,
        retained_mode(policy.mode),
        owner,
        expected_identity,
    )
}

fn retained_mode(archive_mode: u32) -> u32 {
    archive_mode & !0o222
}

fn reopen_bytes(
    root: &File,
    name: &str,
    size: u64,
    digest: Digest32,
    mode: u32,
    owner: (u32, u32),
    expected_identity: Identity,
) -> Result<File, ProvenanceRefusal> {
    let file: File = openat2(root, name, READ_FLAGS, Mode::empty(), RESOLVE)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?
        .into();
    let before = Identity::read(&file)?;
    if before != expected_identity
        || !before.is_regular()
        || before.links != 1
        || before.permissions() != mode
        || before.size != size
        || (before.uid, before.gid) != owner
        || digest_file(&file)? != digest
        || Identity::read(&file)? != before
    {
        return Err(ProvenanceRefusal::RetentionUncertain);
    }
    Ok(file)
}

fn digest_file(file: &File) -> Result<Digest32, ProvenanceRefusal> {
    let size = Identity::read(file)?.size;
    let bytes = read_exact_stable(file, Identity::read(file)?, size)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    Ok(sha256(&bytes))
}

fn file_sizes(files: &[File]) -> Result<u64, ProvenanceRefusal> {
    files.iter().try_fold(0_u64, |sum, file| {
        sum.checked_add(Identity::read(file)?.size)
            .ok_or(ProvenanceRefusal::RetentionUncertain)
    })
}

fn directory_names(root: &File, maximum: usize) -> Result<Vec<String>, ProvenanceRefusal> {
    let scan_fd = openat2(root, c".", DIRECTORY_FLAGS, Mode::empty(), RESOLVE)
        .map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
    let mut buffer = [MaybeUninit::uninit(); 8_192];
    let mut directory = RawDir::new(scan_fd, &mut buffer);
    let mut names = Vec::new();
    while let Some(entry) = directory.next() {
        let entry = entry.map_err(|_| ProvenanceRefusal::RetentionUncertain)?;
        let name = entry.file_name();
        if name == c"." || name == c".." {
            continue;
        }
        let known = name
            .to_str()
            .map_err(|_| ProvenanceRefusal::RetentionUncertain)?
            .to_owned();
        if entry.file_type() != FileType::RegularFile {
            return Err(ProvenanceRefusal::RetentionUncertain);
        }
        names.push(known);
        if names.len() > maximum {
            return Err(ProvenanceRefusal::RetentionUncertain);
        }
    }
    names.sort_unstable();
    Ok(names)
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TestFaultPoint {
    BeforeDestinationSync,
    BeforeDestinationDirectorySync,
    DestinationConsumed,
    BeforeEntrySync(usize),
    EntrySynced(usize),
    BeforeEntriesDirectorySync,
    EntriesDirectorySynced,
    BeforeInventory,
    BeforeInventorySync,
    InventorySynced,
    BeforeInventoryDirectorySync,
    InventoryDirectorySynced,
    Reopened,
    BeforeFinalDirectorySync,
    FinalDirectorySynced,
}

#[cfg(not(test))]
#[derive(Clone, Copy)]
enum TestFaultPoint {
    BeforeDestinationSync,
    BeforeDestinationDirectorySync,
    DestinationConsumed,
    BeforeEntrySync(usize),
    EntrySynced(usize),
    BeforeEntriesDirectorySync,
    EntriesDirectorySynced,
    BeforeInventory,
    BeforeInventorySync,
    InventorySynced,
    BeforeInventoryDirectorySync,
    InventoryDirectorySynced,
    Reopened,
    BeforeFinalDirectorySync,
    FinalDirectorySynced,
}

#[cfg(test)]
std::thread_local! {
    static TEST_FAULT: std::cell::Cell<Option<TestFaultPoint>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_test_fault(point: Option<TestFaultPoint>) {
    TEST_FAULT.set(point);
}

#[cfg(test)]
fn fault(point: TestFaultPoint) -> Result<(), ProvenanceRefusal> {
    if TEST_FAULT.get() == Some(point) {
        TEST_FAULT.set(None);
        Err(ProvenanceRefusal::RetentionUncertain)
    } else {
        Ok(())
    }
}

#[cfg(not(test))]
fn fault(_: TestFaultPoint) -> Result<(), ProvenanceRefusal> {
    Ok(())
}
