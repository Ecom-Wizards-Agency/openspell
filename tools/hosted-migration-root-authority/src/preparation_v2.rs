//! Empty preparation-v2 journal creation and inspection for installation step 3.

use std::os::fd::OwnedFd;

use rustix::fs::{FileType, fstat, fsync};

use crate::journal::storage::{
    acquire_ofd_lock, open_existing, publish, read_exact_file, require_names,
    verify_entry_matches_fd, verify_metadata,
};
use crate::super_lock::{
    HeldStateRoot, RootOwner, create_directory, domain_digest, open_directory_any_links,
};

pub(crate) const JOURNAL_NAME: &str = "PREPARATION_JOURNAL_V2";
pub(crate) const FORMAT_BYTES: &[u8] = b"openspell.hosted-migration-preparation-journal.v2\n";
pub(crate) const FORMAT_SHA256: &str =
    "25b0ecf781f361559c6e59297b4caacbda88742c63bdd28a53cd2a9cc0b4a16a";
pub(crate) const GENESIS_DOMAIN: &[u8] =
    b"openspell.hosted-migration-preparation-journal-genesis.v2\n";
pub(crate) const GENESIS_SHA256: &str =
    "e7ebfa2198a1417a28ff4be3a4c34bb6dc1d37acd9d81da7fcd4007c0a2c1222";
pub(crate) const INVENTORY_DOMAIN: &[u8] = b"openspell.hosted-migration-preparation-inventory.v2\n";
pub(crate) const MAX_TRANSITIONS: usize = 4_096;
pub(crate) const MAX_RECORDS: usize = 12_288;
pub(crate) const MAX_SIGNATURES: usize = 16_384;
pub(crate) const MAX_RECORD_BYTES: usize = 16_384;
pub(crate) const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

pub(crate) struct EmptyPreparationJournal {
    pub(crate) records: OwnedFd,
    pub(crate) signatures: OwnedFd,
    pub(crate) transitions: OwnedFd,
    pub(crate) objects: OwnedFd,
    pub(crate) format: OwnedFd,
    pub(crate) root: OwnedFd,
    pub(crate) identity_sha256: String,
    pub(crate) lock: OwnedFd,
}

pub(crate) fn create(held: &HeldStateRoot) -> Result<EmptyPreparationJournal, ()> {
    let journal = create_directory(&held.root, JOURNAL_NAME, held.owner)?;
    publish(&journal, "FORMAT", FORMAT_BYTES, held.owner.storage())?;
    publish(&journal, "LOCK", b"", held.owner.storage())?;
    let lock = open_existing(
        &journal,
        c"LOCK",
        rustix::fs::OFlags::RDWR
            | rustix::fs::OFlags::CLOEXEC
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::NONBLOCK,
    )?;
    acquire_ofd_lock(&lock)?;
    let objects = create_directory(&journal, "objects", held.owner)?;
    let records = create_directory(&objects, "records", held.owner)?;
    let signatures = create_directory(&objects, "signatures", held.owner)?;
    let transitions = create_directory(&journal, "transitions", held.owner)?;
    fsync(&journal).map_err(|_| ())?;
    fsync(&held.root).map_err(|_| ())?;
    open_verified(
        held,
        Some((journal, lock, objects, records, signatures, transitions)),
    )
}

pub(crate) fn inspect(held: &HeldStateRoot) -> Result<EmptyPreparationJournal, ()> {
    let first = open_verified(held, None)?;
    for file in [&first.format, &first.lock] {
        fsync(file).map_err(|_| ())?;
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
    drop(first);
    open_verified(held, None)
}

fn open_verified(
    held: &HeldStateRoot,
    opened: Option<(OwnedFd, OwnedFd, OwnedFd, OwnedFd, OwnedFd, OwnedFd)>,
) -> Result<EmptyPreparationJournal, ()> {
    let (root, lock, objects, records, signatures, transitions) = match opened {
        Some(fds) => fds,
        None => {
            let root = open_directory_any_links(&held.root, JOURNAL_NAME, held.owner)?;
            let lock = open_existing(
                &root,
                c"LOCK",
                rustix::fs::OFlags::RDWR
                    | rustix::fs::OFlags::CLOEXEC
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK,
            )?;
            acquire_ofd_lock(&lock)?;
            let objects = open_directory_any_links(&root, "objects", held.owner)?;
            let records = open_directory_any_links(&objects, "records", held.owner)?;
            let signatures = open_directory_any_links(&objects, "signatures", held.owner)?;
            let transitions = open_directory_any_links(&root, "transitions", held.owner)?;
            (root, lock, objects, records, signatures, transitions)
        }
    };
    require_names(&root, &["FORMAT", "LOCK", "objects", "transitions"])?;
    require_names(&objects, &["records", "signatures"])?;
    require_names(&records, &[])?;
    require_names(&signatures, &[])?;
    require_names(&transitions, &[])?;
    let format = crate::journal::storage::open_regular(
        &root,
        c"FORMAT",
        held.owner.storage(),
        FORMAT_BYTES.len(),
        false,
    )?;
    if read_exact_file(&format, FORMAT_BYTES.len())? != FORMAT_BYTES {
        return Err(());
    }
    let lock_stat = verify_entry_matches_fd(
        &root,
        c"LOCK",
        &lock,
        held.owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if lock_stat.st_size != 0 {
        return Err(());
    }
    let root_stat = fstat(&root).map_err(|_| ())?;
    verify_metadata(
        &root_stat,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    let identity_sha256 = journal_identity(&root, held.owner)?;
    Ok(EmptyPreparationJournal {
        root,
        format,
        lock,
        objects,
        records,
        signatures,
        transitions,
        identity_sha256,
    })
}

pub(crate) fn revalidate(
    held: &HeldStateRoot,
    journal: &EmptyPreparationJournal,
) -> Result<(), ()> {
    crate::super_lock::revalidate(held)?;
    if journal_identity(&journal.root, held.owner)? != journal.identity_sha256 {
        return Err(());
    }
    verify_entry_matches_fd(
        &held.root,
        c"PREPARATION_JOURNAL_V2",
        &journal.root,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    require_names(&journal.root, &["FORMAT", "LOCK", "objects", "transitions"])?;
    require_names(&journal.objects, &["records", "signatures"])?;
    require_names(&journal.records, &[])?;
    require_names(&journal.signatures, &[])?;
    require_names(&journal.transitions, &[])?;
    if read_exact_file(&journal.format, FORMAT_BYTES.len())? != FORMAT_BYTES {
        return Err(());
    }
    let format_stat = verify_entry_matches_fd(
        &journal.root,
        c"FORMAT",
        &journal.format,
        held.owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if format_stat.st_size != FORMAT_BYTES.len() as i64 {
        return Err(());
    }
    let lock_stat = verify_entry_matches_fd(
        &journal.root,
        c"LOCK",
        &journal.lock,
        held.owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if lock_stat.st_size != 0 {
        return Err(());
    }
    verify_entry_matches_fd(
        &journal.root,
        c"objects",
        &journal.objects,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    verify_entry_matches_fd(
        &journal.objects,
        c"records",
        &journal.records,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &journal.objects,
        c"signatures",
        &journal.signatures,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    verify_entry_matches_fd(
        &journal.root,
        c"transitions",
        &journal.transitions,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        2,
    )?;
    Ok(())
}

fn journal_identity(root: &OwnedFd, owner: RootOwner) -> Result<String, ()> {
    let stat = fstat(root).map_err(|_| ())?;
    verify_metadata(&stat, owner.storage(), FileType::Directory, 0o700, 4)?;
    let canonical = format!(
        concat!(
            "{{\n",
            "  \"schemaVersion\": \"openspell.hosted-migration-journal-identity.v1\",\n",
            "  \"activeFormat\": \"preparation_v2\",\n",
            "  \"activeJournalName\": \"PREPARATION_JOURNAL_V2\",\n",
            "  \"filesystemDeviceDecimal\": \"{}\",\n",
            "  \"inodeDecimal\": \"{}\",\n",
            "  \"ownerUid\": {},\n",
            "  \"ownerGid\": {},\n",
            "  \"modeOctal\": \"0700\",\n",
            "  \"formatSha256\": \"{}\"\n",
            "}}\n"
        ),
        stat.st_dev, stat.st_ino, owner.uid, owner.gid, FORMAT_SHA256
    );
    Ok(domain_digest(
        b"openspell.hosted-migration-journal-identity.v1\n",
        canonical.as_bytes(),
    ))
}
