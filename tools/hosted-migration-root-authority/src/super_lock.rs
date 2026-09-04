//! State-root identity and the single cross-format OFD super-lock.

use std::os::fd::OwnedFd;

use nix::fcntl::{FcntlArg, FdFlag, OFlag, fcntl};
use rustix::fs::{FileType, Mode, OFlags, ResolveFlags, fstat, fsync, mkdirat, openat2};
use sha2::{Digest as _, Sha256};

use crate::journal::storage::{
    Owner, acquire_ofd_lock, open_existing, publish, read_names, verify_entry_matches_fd,
    verify_metadata,
};

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);

pub(crate) const SUPER_LOCK_NAME: &str = "AUTHORITY_SUPER_LOCK";

#[cfg(test)]
pub(crate) const SUPER_LOCK_ACQUIRED_MARKER: &[u8] = b"openspell.wp201.super-lock-acquired.v1\n";

#[cfg(test)]
std::thread_local! {
    static ACQUIRED_MARKER: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) fn test_set_super_lock_acquired_marker(action: impl FnOnce() + 'static) {
    ACQUIRED_MARKER.with_borrow_mut(|slot| {
        assert!(
            slot.replace(Box::new(action)).is_none(),
            "single acquisition marker"
        );
    });
}

#[cfg(test)]
fn test_mark_super_lock_acquired() -> Result<(), ()> {
    let action = ACQUIRED_MARKER.with_borrow_mut(Option::take);
    if let Some(action) = action {
        action();
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) struct ExpectedOwner {
    uid: u32,
    gid: u32,
}

impl ExpectedOwner {
    pub(crate) const fn root() -> Self {
        Self { uid: 0, gid: 0 }
    }

    #[cfg(test)]
    pub(crate) const fn for_test(uid: u32, gid: u32) -> Self {
        Self { uid, gid }
    }

    pub(crate) const fn uid(self) -> u32 {
        self.uid
    }

    pub(crate) const fn gid(self) -> u32 {
        self.gid
    }
}

#[derive(Clone, Copy)]
pub(crate) struct RootOwner {
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) dev: u64,
}

impl RootOwner {
    pub(crate) fn storage(self) -> Owner {
        Owner {
            uid: self.uid,
            gid: self.gid,
            dev: self.dev,
        }
    }
}

pub(crate) struct HeldStateRoot {
    pub(crate) root: OwnedFd,
    pub(crate) lock: OwnedFd,
    pub(crate) owner: RootOwner,
    pub(crate) root_identity_sha256: String,
    pub(crate) lock_identity_sha256: String,
}

pub(crate) fn verify_input_directory_descriptor(fd: &OwnedFd) -> Result<(), ()> {
    let descriptor_flags =
        FdFlag::from_bits(fcntl(fd, FcntlArg::F_GETFD).map_err(|_| ())?).ok_or(())?;
    let status_flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL).map_err(|_| ())?);
    if !descriptor_flags.contains(FdFlag::FD_CLOEXEC)
        || status_flags & OFlag::O_ACCMODE != OFlag::O_RDONLY
        || !status_flags.contains(OFlag::O_DIRECTORY)
        || status_flags.contains(OFlag::O_APPEND)
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn inspect_empty_root(root: &OwnedFd, expected: ExpectedOwner) -> Result<RootOwner, ()> {
    verify_input_directory_descriptor(root)?;
    let stat = fstat(root).map_err(|_| ())?;
    let owner = RootOwner {
        uid: expected.uid,
        gid: expected.gid,
        dev: stat.st_dev,
    };
    verify_metadata(&stat, owner.storage(), FileType::Directory, 0o700, 2)?;
    verify_state_filesystem(root)?;
    if !read_names(root, 0)?.is_empty() {
        return Err(());
    }
    Ok(owner)
}

pub(crate) fn state_root_identity(root: &OwnedFd, owner: RootOwner) -> Result<String, ()> {
    let stat = fstat(root).map_err(|_| ())?;
    verify_metadata(
        &stat,
        owner.storage(),
        FileType::Directory,
        0o700,
        stat.st_nlink,
    )?;
    let canonical = format!(
        concat!(
            "{{\n",
            "  \"schemaVersion\": \"openspell.hosted-migration-state-root-identity.v1\",\n",
            "  \"filesystemDeviceDecimal\": \"{}\",\n",
            "  \"inodeDecimal\": \"{}\",\n",
            "  \"ownerUid\": {},\n",
            "  \"ownerGid\": {},\n",
            "  \"modeOctal\": \"0700\"\n",
            "}}\n"
        ),
        stat.st_dev, stat.st_ino, owner.uid, owner.gid
    );
    Ok(domain_digest(
        b"openspell.hosted-migration-state-root-identity.v1\n",
        canonical.as_bytes(),
    ))
}

pub(crate) fn create_and_lock(root: OwnedFd, owner: RootOwner) -> Result<HeldStateRoot, ()> {
    let root_identity_sha256 = state_root_identity(&root, owner)?;
    #[cfg(test)]
    crate::journal::storage::test_before_first_publication_cut()?;
    publish(&root, SUPER_LOCK_NAME, b"", owner.storage())?;
    let lock = open_existing(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
    )?;
    acquire_ofd_lock(&lock)?;
    verify_entry_matches_fd(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        &lock,
        owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    let lock_identity_sha256 = super_lock_identity(&lock, owner)?;
    Ok(HeldStateRoot {
        root,
        lock,
        owner,
        root_identity_sha256,
        lock_identity_sha256,
    })
}

pub(crate) fn open_and_lock(root: OwnedFd, expected: ExpectedOwner) -> Result<HeldStateRoot, ()> {
    verify_input_directory_descriptor(&root)?;
    let stat = fstat(&root).map_err(|_| ())?;
    let owner = RootOwner {
        uid: expected.uid,
        gid: expected.gid,
        dev: stat.st_dev,
    };
    verify_metadata(&stat, owner.storage(), FileType::Directory, 0o700, 4)?;
    verify_state_filesystem(&root)?;
    let lock = open_existing(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
    )?;
    acquire_ofd_lock(&lock)?;
    verify_entry_matches_fd(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        &lock,
        owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    let root_identity_sha256 = state_root_identity(&root, owner)?;
    let lock_identity_sha256 = super_lock_identity(&lock, owner)?;
    #[cfg(test)]
    test_mark_super_lock_acquired()?;
    Ok(HeldStateRoot {
        root_identity_sha256,
        lock_identity_sha256,
        root,
        lock,
        owner,
    })
}

#[cfg(test)]
pub(crate) fn open_and_lock_untyped_for_test(
    root: OwnedFd,
    expected: ExpectedOwner,
) -> Result<HeldStateRoot, ()> {
    verify_input_directory_descriptor(&root)?;
    let stat = fstat(&root).map_err(|_| ())?;
    let owner = RootOwner {
        uid: expected.uid,
        gid: expected.gid,
        dev: stat.st_dev,
    };
    verify_metadata(
        &stat,
        owner.storage(),
        FileType::Directory,
        0o700,
        stat.st_nlink,
    )?;
    verify_state_filesystem(&root)?;
    let lock = open_existing(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
    )?;
    acquire_ofd_lock(&lock)?;
    verify_entry_matches_fd(
        &root,
        c"AUTHORITY_SUPER_LOCK",
        &lock,
        owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    let root_identity_sha256 = state_root_identity(&root, owner)?;
    let lock_identity_sha256 = super_lock_identity(&lock, owner)?;
    test_mark_super_lock_acquired()?;
    Ok(HeldStateRoot {
        root_identity_sha256,
        lock_identity_sha256,
        root,
        lock,
        owner,
    })
}

pub(crate) fn revalidate(held: &HeldStateRoot) -> Result<(), ()> {
    crate::journal::storage::require_names(
        &held.root,
        &[
            "AUTHORITY_SUPER_LOCK",
            "AUTHORITY_REGISTRY",
            "PREPARATION_JOURNAL_V2",
        ],
    )?;
    let root_stat = fstat(&held.root).map_err(|_| ())?;
    verify_metadata(
        &root_stat,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        4,
    )?;
    if state_root_identity(&held.root, held.owner)? != held.root_identity_sha256
        || super_lock_identity(&held.lock, held.owner)? != held.lock_identity_sha256
    {
        return Err(());
    }
    verify_entry_matches_fd(
        &held.root,
        c"AUTHORITY_SUPER_LOCK",
        &held.lock,
        held.owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn revalidate_untyped_for_test(held: &HeldStateRoot) -> Result<(), ()> {
    let root_stat = fstat(&held.root).map_err(|_| ())?;
    verify_metadata(
        &root_stat,
        held.owner.storage(),
        FileType::Directory,
        0o700,
        root_stat.st_nlink,
    )?;
    if state_root_identity(&held.root, held.owner)? != held.root_identity_sha256
        || super_lock_identity(&held.lock, held.owner)? != held.lock_identity_sha256
    {
        return Err(());
    }
    verify_entry_matches_fd(
        &held.root,
        c"AUTHORITY_SUPER_LOCK",
        &held.lock,
        held.owner.storage(),
        FileType::RegularFile,
        0o600,
        1,
    )?;
    Ok(())
}

fn super_lock_identity(lock: &OwnedFd, owner: RootOwner) -> Result<String, ()> {
    let stat = fstat(lock).map_err(|_| ())?;
    verify_metadata(&stat, owner.storage(), FileType::RegularFile, 0o600, 1)?;
    if stat.st_size != 0 {
        return Err(());
    }
    let canonical = format!(
        concat!(
            "{{\n",
            "  \"schemaVersion\": \"openspell.hosted-migration-authority-super-lock-identity.v1\",\n",
            "  \"filesystemDeviceDecimal\": \"{}\",\n",
            "  \"inodeDecimal\": \"{}\",\n",
            "  \"ownerUid\": {},\n",
            "  \"ownerGid\": {},\n",
            "  \"modeOctal\": \"0600\",\n",
            "  \"linkCount\": 1,\n",
            "  \"sizeBytes\": 0\n",
            "}}\n"
        ),
        stat.st_dev, stat.st_ino, owner.uid, owner.gid
    );
    Ok(domain_digest(
        b"openspell.hosted-migration-authority-super-lock-identity.v1\n",
        canonical.as_bytes(),
    ))
}

pub(crate) fn create_directory(
    parent: &OwnedFd,
    name: &str,
    owner: RootOwner,
) -> Result<OwnedFd, ()> {
    #[cfg(test)]
    let ordinal = crate::journal::storage::test_next_directory();
    mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR).map_err(|_| ())?;
    #[cfg(test)]
    crate::journal::storage::test_directory_cut(
        ordinal,
        crate::journal::storage::TestDirectoryBoundary::Created,
    )?;
    fsync(parent).map_err(|_| ())?;
    #[cfg(test)]
    crate::journal::storage::test_directory_cut(
        ordinal,
        crate::journal::storage::TestDirectoryBoundary::ParentSynced,
    )?;
    let fd = openat2(parent, name, DIRECTORY_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
    let stat = fstat(&fd).map_err(|_| ())?;
    verify_metadata(&stat, owner.storage(), FileType::Directory, 0o700, 2)?;
    Ok(fd)
}

pub(crate) fn open_directory_any_links(
    parent: &OwnedFd,
    name: &str,
    owner: RootOwner,
) -> Result<OwnedFd, ()> {
    let fd = openat2(parent, name, DIRECTORY_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
    let stat = fstat(&fd).map_err(|_| ())?;
    verify_metadata(
        &stat,
        owner.storage(),
        FileType::Directory,
        0o700,
        stat.st_nlink,
    )?;
    Ok(fd)
}

pub(crate) fn domain_digest(domain: &[u8], canonical: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(canonical);
    hex::encode(hash.finalize())
}

fn verify_state_filesystem(fd: &OwnedFd) -> Result<(), ()> {
    let magic = rustix::fs::fstatfs(fd).map_err(|_| ())?.f_type as u64;
    if ![0xef53, 0x5846_5342, 0x0102_1994].contains(&magic) {
        return Err(());
    }
    Ok(())
}
