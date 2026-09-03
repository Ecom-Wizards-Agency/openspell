//! Safe Linux fd-relative tree access and lifetime OFD locking.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CStr;
use std::mem::MaybeUninit;
use std::os::fd::OwnedFd;
use std::sync::Mutex;

use nix::fcntl::{FcntlArg, fcntl};
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, RawDir, ResolveFlags, Stat, fstat, fstatfs, fsync, openat2,
    statat,
};
use rustix::io::{Errno, read, write};

use super::{
    FORMAT_BYTES, InventoryFiles, MAX_CANONICAL_BYTES, MAX_LEAVES, MAX_SIGNATURES, MAX_TOTAL_BYTES,
    MAX_TRANSITIONS, TransitionFile, VerifiedSnapshot, verify_inventory,
};

const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_MAGICLINKS)
    .union(ResolveFlags::NO_XDEV);
const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);
const CREATE_FLAGS: OFlags = OFlags::WRONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CREATE)
    .union(OFlags::EXCL);

const EXT_FAMILY_MAGIC: u64 = 0xef53;
const XFS_MAGIC: u64 = 0x5846_5342;
const TMPFS_MAGIC: u64 = 0x0102_1994;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OpenError {
    Lock,
    Root,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StorageError {
    Sealed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Health {
    Available,
    RecoveredNonterminal,
    Sealed,
}

#[derive(Clone, Copy)]
struct Owner {
    uid: u32,
    gid: u32,
    dev: u64,
}

struct JournalFds {
    root: OwnedFd,
    objects: OwnedFd,
    leaves: OwnedFd,
    signatures: OwnedFd,
    transitions: OwnedFd,
    format: OwnedFd,
    lock: OwnedFd,
}

pub(crate) struct JournalStore {
    fds: JournalFds,
    owner: Owner,
    pinned_public_key: [u8; 32],
    gate: Mutex<Health>,
}

impl JournalStore {
    pub(crate) fn open_from_fd(
        root: OwnedFd,
        expected_uid: u32,
        expected_gid: u32,
        pinned_public_key: [u8; 32],
    ) -> Result<Self, OpenError> {
        let root_stat = fstat(&root).map_err(|_| OpenError::Root)?;
        let owner = Owner {
            uid: expected_uid,
            gid: expected_gid,
            dev: root_stat.st_dev,
        };
        verify_directory(&root_stat, owner, 0o700, 4).map_err(|_| OpenError::Root)?;
        verify_local_filesystem(&root).map_err(|_| OpenError::Root)?;
        require_names(&root, &["FORMAT", "LOCK", "objects", "transitions"])
            .map_err(|_| OpenError::Root)?;

        let objects = open_directory(&root, c"objects", owner, 4).map_err(|_| OpenError::Root)?;
        require_names(&objects, &["leaves", "signatures"]).map_err(|_| OpenError::Root)?;
        let leaves = open_directory(&objects, c"leaves", owner, 2).map_err(|_| OpenError::Root)?;
        let signatures =
            open_directory(&objects, c"signatures", owner, 2).map_err(|_| OpenError::Root)?;
        let transitions =
            open_directory(&root, c"transitions", owner, 2).map_err(|_| OpenError::Root)?;

        let format = open_regular(&root, c"FORMAT", owner, FORMAT_BYTES.len(), false)
            .map_err(|_| OpenError::Root)?;
        if read_exact_file(&format, FORMAT_BYTES.len()).map_err(|_| OpenError::Root)?
            != FORMAT_BYTES
        {
            return Err(OpenError::Root);
        }
        let lock = open_regular(&root, c"LOCK", owner, 0, true).map_err(|_| OpenError::Root)?;
        acquire_ofd_lock(&lock).map_err(|_| OpenError::Lock)?;
        verify_entry_matches_fd(
            &root,
            c"LOCK",
            &lock,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )
        .map_err(|_| OpenError::Root)?;

        let store = Self {
            fds: JournalFds {
                root,
                objects,
                leaves,
                signatures,
                transitions,
                format,
                lock,
            },
            owner,
            pinned_public_key,
            gate: Mutex::new(Health::Available),
        };
        let initial = store.scan();
        let health = match initial {
            Ok(snapshot) if snapshot.state.is_nonterminal() => Health::RecoveredNonterminal,
            Ok(_) => Health::Available,
            Err(_) => Health::Sealed,
        };
        *store.gate.lock().map_err(|_| OpenError::Root)? = health;
        Ok(store)
    }

    pub(crate) fn inspect(&self) -> Result<(Health, VerifiedSnapshot), StorageError> {
        let mut health = self.gate.lock().map_err(|_| StorageError::Unavailable)?;
        if *health == Health::Sealed {
            return Err(StorageError::Sealed);
        }
        match self.scan() {
            Ok(snapshot) => Ok((*health, snapshot)),
            Err(_) => {
                *health = Health::Sealed;
                Err(StorageError::Unavailable)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn publish_test_transition(
        &self,
        leaves: &[(&[u8], &str)],
        signatures: &[(&[u8], &str)],
        transition: &TransitionFile,
        generation: u64,
    ) -> Result<(), StorageError> {
        let mut health = self.gate.lock().map_err(|_| StorageError::Unavailable)?;
        if *health != Health::Available {
            return Err(StorageError::Sealed);
        }
        if self.scan().is_err() {
            *health = Health::Sealed;
            return Err(StorageError::Unavailable);
        }
        for (bytes, digest) in leaves {
            if publish(&self.fds.leaves, digest, bytes, self.owner).is_err() {
                *health = Health::Sealed;
                return Err(StorageError::Unavailable);
            }
        }
        for (bytes, digest) in signatures {
            if publish(&self.fds.signatures, digest, bytes, self.owner).is_err() {
                *health = Health::Sealed;
                return Err(StorageError::Unavailable);
            }
        }
        let name = format!("{generation:020}-{}.json", transition.digest);
        if publish(&self.fds.transitions, &name, &transition.bytes, self.owner).is_err()
            || self.scan().is_err()
        {
            *health = Health::Sealed;
            return Err(StorageError::Unavailable);
        }
        Ok(())
    }

    fn scan(&self) -> Result<VerifiedSnapshot, ()> {
        verify_directory(
            &fstat(&self.fds.root).map_err(|_| ())?,
            self.owner,
            0o700,
            4,
        )?;
        verify_local_filesystem(&self.fds.root)?;
        require_names(
            &self.fds.root,
            &["FORMAT", "LOCK", "objects", "transitions"],
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"objects",
            &self.fds.objects,
            self.owner,
            FileType::Directory,
            0o700,
            4,
        )?;
        require_names(&self.fds.objects, &["leaves", "signatures"])?;
        verify_entry_matches_fd(
            &self.fds.objects,
            c"leaves",
            &self.fds.leaves,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.objects,
            c"signatures",
            &self.fds.signatures,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"transitions",
            &self.fds.transitions,
            self.owner,
            FileType::Directory,
            0o700,
            2,
        )?;
        verify_entry_matches_fd(
            &self.fds.root,
            c"FORMAT",
            &self.fds.format,
            self.owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if read_exact_file(&self.fds.format, FORMAT_BYTES.len())? != FORMAT_BYTES {
            return Err(());
        }
        verify_entry_matches_fd(
            &self.fds.root,
            c"LOCK",
            &self.fds.lock,
            self.owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if fstat(&self.fds.lock).map_err(|_| ())?.st_size != 0 {
            return Err(());
        }
        let mut total_bytes = FORMAT_BYTES.len();
        let leaves = scan_objects(
            &self.fds.leaves,
            self.owner,
            MAX_LEAVES,
            false,
            &mut total_bytes,
        )?;
        let signatures = scan_objects(
            &self.fds.signatures,
            self.owner,
            MAX_SIGNATURES,
            true,
            &mut total_bytes,
        )?;
        let transitions = scan_transitions(&self.fds.transitions, self.owner, &mut total_bytes)?;
        let inventory = InventoryFiles {
            leaves,
            signatures,
            transitions,
        };
        verify_inventory(&inventory, &self.pinned_public_key).map_err(|_| ())
    }
}

fn verify_local_filesystem(fd: &OwnedFd) -> Result<(), ()> {
    let magic = fstatfs(fd).map_err(|_| ())?.f_type as u64;
    let synthetic_tmpfs = cfg!(test) && magic == TMPFS_MAGIC;
    if ![EXT_FAMILY_MAGIC, XFS_MAGIC].contains(&magic) && !synthetic_tmpfs {
        return Err(());
    }
    Ok(())
}

fn open_directory(parent: &OwnedFd, name: &CStr, owner: Owner, nlink: u64) -> Result<OwnedFd, ()> {
    let fd = openat2(parent, name, DIRECTORY_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
    verify_entry_matches_fd(parent, name, &fd, owner, FileType::Directory, 0o700, nlink)?;
    Ok(fd)
}

fn open_regular(
    parent: &OwnedFd,
    name: &CStr,
    owner: Owner,
    size: usize,
    writable: bool,
) -> Result<OwnedFd, ()> {
    let flags = if writable {
        OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOFOLLOW
    } else {
        READ_FLAGS
    };
    let fd = openat2(parent, name, flags, Mode::empty(), RESOLVE).map_err(|_| ())?;
    verify_entry_matches_fd(parent, name, &fd, owner, FileType::RegularFile, 0o600, 1)?;
    if fstat(&fd).map_err(|_| ())?.st_size != size as i64 {
        return Err(());
    }
    Ok(fd)
}

fn verify_entry_matches_fd(
    parent: &OwnedFd,
    name: &CStr,
    fd: &OwnedFd,
    owner: Owner,
    file_type: FileType,
    mode: u32,
    nlink: u64,
) -> Result<Stat, ()> {
    let entry = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| ())?;
    let opened = fstat(fd).map_err(|_| ())?;
    if entry.st_dev != opened.st_dev
        || entry.st_ino != opened.st_ino
        || entry.st_mode != opened.st_mode
        || entry.st_uid != opened.st_uid
        || entry.st_gid != opened.st_gid
        || entry.st_nlink != opened.st_nlink
        || entry.st_size != opened.st_size
    {
        return Err(());
    }
    verify_metadata(&opened, owner, file_type, mode, nlink)?;
    Ok(opened)
}

fn verify_directory(stat: &Stat, owner: Owner, mode: u32, nlink: u64) -> Result<(), ()> {
    verify_metadata(stat, owner, FileType::Directory, mode, nlink)
}

fn verify_metadata(
    stat: &Stat,
    owner: Owner,
    expected_type: FileType,
    expected_mode: u32,
    expected_nlink: u64,
) -> Result<(), ()> {
    if FileType::from_raw_mode(stat.st_mode) != expected_type
        || Mode::from_raw_mode(stat.st_mode).as_raw_mode() != expected_mode
        || stat.st_uid != owner.uid
        || stat.st_gid != owner.gid
        || stat.st_dev != owner.dev
        || stat.st_nlink != expected_nlink
        || stat.st_size < 0
    {
        return Err(());
    }
    Ok(())
}

fn require_names(directory: &OwnedFd, expected: &[&str]) -> Result<(), ()> {
    let actual: BTreeSet<String> = read_names(directory)?.into_iter().collect();
    let expected: BTreeSet<String> = expected.iter().map(|name| (*name).to_owned()).collect();
    if actual != expected {
        return Err(());
    }
    Ok(())
}

fn read_names(directory: &OwnedFd) -> Result<Vec<String>, ()> {
    rustix::fs::seek(directory, rustix::fs::SeekFrom::Start(0)).map_err(|_| ())?;
    let mut buffer = [MaybeUninit::<u8>::uninit(); 8192];
    let mut reader = RawDir::new(directory, &mut buffer);
    let mut names = Vec::new();
    while let Some(entry) = reader.next() {
        let entry = entry.map_err(|_| ())?;
        let bytes = entry.file_name().to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        names.push(std::str::from_utf8(bytes).map_err(|_| ())?.to_owned());
    }
    Ok(names)
}

fn scan_objects(
    directory: &OwnedFd,
    owner: Owner,
    limit: usize,
    signatures: bool,
    total: &mut usize,
) -> Result<BTreeMap<String, Vec<u8>>, ()> {
    let names = read_names(directory)?;
    if names.len() > limit {
        return Err(());
    }
    let mut objects = BTreeMap::new();
    for name in names {
        if !is_digest(&name) {
            return Err(());
        }
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if (signatures && size != 64) || (!signatures && (size == 0 || size > MAX_CANONICAL_BYTES))
        {
            return Err(());
        }
        *total = total.checked_add(size).ok_or(())?;
        if *total > MAX_TOTAL_BYTES {
            return Err(());
        }
        let bytes = read_exact_file(&fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat) {
            return Err(());
        }
        if name != crate::crypto::sha256_hex(&bytes) || objects.insert(name, bytes).is_some() {
            return Err(());
        }
    }
    Ok(objects)
}

fn scan_transitions(
    directory: &OwnedFd,
    owner: Owner,
    total: &mut usize,
) -> Result<BTreeMap<u64, TransitionFile>, ()> {
    let names = read_names(directory)?;
    if names.len() > MAX_TRANSITIONS {
        return Err(());
    }
    let mut transitions = BTreeMap::new();
    for name in names {
        let (generation, digest) = parse_transition_name(&name)?;
        let c_name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
        let fd = openat2(directory, &c_name, READ_FLAGS, Mode::empty(), RESOLVE).map_err(|_| ())?;
        let stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        let size = usize::try_from(stat.st_size).map_err(|_| ())?;
        if size == 0 || size > MAX_CANONICAL_BYTES {
            return Err(());
        }
        *total = total.checked_add(size).ok_or(())?;
        if *total > MAX_TOTAL_BYTES {
            return Err(());
        }
        let bytes = read_exact_file(&fd, size)?;
        let final_stat = verify_entry_matches_fd(
            directory,
            &c_name,
            &fd,
            owner,
            FileType::RegularFile,
            0o600,
            1,
        )?;
        if !same_stat(&stat, &final_stat) {
            return Err(());
        }
        if digest != crate::crypto::sha256_hex(&bytes)
            || transitions
                .insert(generation, TransitionFile { digest, bytes })
                .is_some()
        {
            return Err(());
        }
    }
    Ok(transitions)
}

fn parse_transition_name(name: &str) -> Result<(u64, String), ()> {
    if name.len() != 20 + 1 + 64 + 5
        || name.as_bytes().get(20) != Some(&b'-')
        || !name.ends_with(".json")
        || !name.as_bytes()[..20].iter().all(u8::is_ascii_digit)
    {
        return Err(());
    }
    let digest = &name[21..85];
    if !is_digest(digest) {
        return Err(());
    }
    let generation = name[..20].parse::<u64>().map_err(|_| ())?;
    if generation == 0 || generation > 9_999_999_999 {
        return Err(());
    }
    Ok((generation, digest.to_owned()))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_exact_file(fd: &OwnedFd, size: usize) -> Result<Vec<u8>, ()> {
    rustix::fs::seek(fd, rustix::fs::SeekFrom::Start(0)).map_err(|_| ())?;
    let mut bytes = vec![0; size];
    let mut offset = 0;
    while offset < size {
        match read(fd, &mut bytes[offset..]) {
            Ok(0) => return Err(()),
            Ok(read_count) => offset += read_count,
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    let mut extra = [0_u8; 1];
    match read(fd, &mut extra) {
        Ok(0) => {}
        Ok(_) => return Err(()),
        Err(Errno::INTR) => return Err(()),
        Err(_) => return Err(()),
    }
    Ok(bytes)
}

fn acquire_ofd_lock(fd: &OwnedFd) -> Result<(), ()> {
    let lock = nix::libc::flock {
        l_type: nix::libc::F_WRLCK as nix::libc::c_short,
        l_whence: nix::libc::SEEK_SET as nix::libc::c_short,
        l_start: 0,
        l_len: 0,
        l_pid: 0,
    };
    fcntl(fd, FcntlArg::F_OFD_SETLK(&lock)).map_err(|_| ())?;
    Ok(())
}

fn publish(directory: &OwnedFd, name: &str, bytes: &[u8], owner: Owner) -> Result<(), ()> {
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| ())?;
    let fd = openat2(
        directory,
        &name,
        CREATE_FLAGS,
        Mode::RUSR | Mode::WUSR,
        RESOLVE,
    )
    .map_err(|_| ())?;
    let mut offset = 0;
    while offset < bytes.len() {
        match write(&fd, &bytes[offset..]) {
            Ok(0) => return Err(()),
            Ok(written) => offset += written,
            Err(Errno::INTR) => {}
            Err(_) => return Err(()),
        }
    }
    let published = verify_entry_matches_fd(
        directory,
        &name,
        &fd,
        owner,
        FileType::RegularFile,
        0o600,
        1,
    )?;
    if published.st_size != bytes.len() as i64 {
        return Err(());
    }
    fsync(&fd).map_err(|_| ())?;
    fsync(directory).map_err(|_| ())?;
    Ok(())
}

fn same_stat(left: &Stat, right: &Stat) -> bool {
    left.st_dev == right.st_dev
        && left.st_ino == right.st_ino
        && left.st_mode == right.st_mode
        && left.st_nlink == right.st_nlink
        && left.st_uid == right.st_uid
        && left.st_gid == right.st_gid
        && left.st_size == right.st_size
        && left.st_mtime == right.st_mtime
        && left.st_mtime_nsec == right.st_mtime_nsec
        && left.st_ctime == right.st_ctime
        && left.st_ctime_nsec == right.st_ctime_nsec
}
