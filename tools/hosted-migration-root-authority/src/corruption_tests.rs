use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions, Permissions};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use nix::sys::stat::Mode as NixMode;
use nix::unistd::mkfifo;
use rustix::fs::{AtFlags, Mode, OFlags, ResolveFlags, fstat, fstatfs, openat2, statat};

use crate::canonical::MAX_CANONICAL_BYTES;
use crate::crypto::{RecordSigner, SyntheticRecordSigner, sha256_hex};
use crate::journal::storage::{
    HeadCas, JournalStore, OpenError, RegisterCommand, RootAuthority, StorageError, TicketEntropy,
    TrustedClock, guarded_metadata_open_for_test, guarded_open_directory_for_test,
    test_artifact_content_reads, test_reset_artifact_content_reads,
    verify_local_filesystem_for_test,
};
use crate::journal::{
    FORMAT_BYTES, InventoryFiles, JournalError, MAX_LEAVES, MAX_SIGNATURES, MAX_TOTAL_BYTES,
    MAX_TRANSITIONS, TransitionFile, verify_inventory,
};
use crate::records::{CANDIDATE_SCHEMA, Candidate, GENESIS_SHA256};

const NOW: &str = "2026-09-03T12:05:00Z";

struct FixedClock;

impl TrustedClock for FixedClock {
    fn sample(&self) -> Result<String, ()> {
        Ok(NOW.to_owned())
    }
}

struct FixedEntropy;

impl TicketEntropy for FixedEntropy {
    fn draw_once(&self) -> Result<[u8; 32], ()> {
        Ok([3; 32])
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct TreeEntry {
    relative_name: String,
    kind: &'static str,
    mode: u32,
    links: u64,
    size: u64,
    payload: Vec<u8>,
}

fn digest(character: char) -> String {
    std::iter::repeat_n(character, 64).collect()
}

fn candidate() -> Candidate {
    Candidate {
        schema_version: CANDIDATE_SCHEMA.to_owned(),
        operation_id: digest('1'),
        authorization_nonce: digest('2'),
        target_fingerprint: digest('3'),
        target_selection_sha256: digest('4'),
        envelope_sha256: digest('5'),
        envelope_expires_at: "2026-09-03T12:15:00Z".to_owned(),
        external_exclusive_window_generation: 7,
        external_exclusive_window_evidence_sha256: digest('6'),
        external_exclusive_window_expires_at: "2026-09-03T12:15:00.000Z".to_owned(),
        official_source_evidence_sha256: digest('7'),
        native_runtime_identity_sha256: digest('8'),
        child_sandbox_policy_sha256: digest('9'),
        phase_exec_topology_policy_sha256: digest('a'),
        child_cgroup_policy_sha256: digest('b'),
        apply_invocation_evidence_sha256: digest('c'),
        operation_authority_incarnation_sha256: String::new(),
        candidate_binding_sha256: String::new(),
        approval_challenge_sha256: String::new(),
        stored_at: String::new(),
        cutoff_at: String::new(),
    }
}

fn new_tree() -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("journal directory");
    let root = directory.path();
    fs::set_permissions(root, Permissions::from_mode(0o700)).expect("root mode");
    fs::create_dir(root.join("objects")).expect("objects");
    fs::create_dir(root.join("objects/leaves")).expect("leaves");
    fs::create_dir(root.join("objects/signatures")).expect("signatures");
    fs::create_dir(root.join("transitions")).expect("transitions");
    for child in [
        root.join("objects"),
        root.join("objects/leaves"),
        root.join("objects/signatures"),
        root.join("transitions"),
    ] {
        fs::set_permissions(child, Permissions::from_mode(0o700)).expect("directory mode");
    }
    fs::write(root.join("FORMAT"), FORMAT_BYTES).expect("format");
    File::create(root.join("LOCK")).expect("lock");
    for child in [root.join("FORMAT"), root.join("LOCK")] {
        fs::set_permissions(child, Permissions::from_mode(0o600)).expect("file mode");
    }
    directory
}

fn open_store(
    root: &Path,
    public_key: [u8; 32],
    expected_uid: u32,
    expected_gid: u32,
) -> Result<JournalStore, OpenError> {
    let root_fd: OwnedFd = File::open(root).expect("root descriptor").into();
    JournalStore::open_from_fd(root_fd, expected_uid, expected_gid, public_key)
}

fn registered_tree() -> (tempfile::TempDir, [u8; 32]) {
    let directory = new_tree();
    let metadata = fs::metadata(directory.path()).expect("root metadata");
    let signer = SyntheticRecordSigner::from_seed([7; 32]);
    let public_key = signer.public_key_bytes();
    let store = open_store(directory.path(), public_key, metadata.uid(), metadata.gid())
        .expect("valid empty store");
    let authority = RootAuthority::synthetic(store, signer, FixedClock, FixedEntropy)
        .expect("synthetic authority");
    let outcome = authority.register(RegisterCommand::new(
        HeadCas::new(0, GENESIS_SHA256.to_owned()),
        candidate(),
    ));
    assert!(outcome.is_ok(), "valid registration must commit");
    drop(outcome);
    drop(authority);
    (directory, public_key)
}

fn sole_file(directory: impl AsRef<Path>) -> PathBuf {
    let mut entries: Vec<_> = fs::read_dir(directory)
        .expect("artifact directory")
        .map(|entry| entry.expect("artifact entry").path())
        .collect();
    entries.sort();
    assert_eq!(entries.len(), 1, "one registration artifact expected");
    entries.pop().expect("single artifact")
}

fn replace_with_fifo(path: &Path) {
    if path.exists() {
        fs::remove_file(path).expect("remove replaced file");
    }
    mkfifo(path, NixMode::from_bits_truncate(0o600)).expect("create FIFO");
    fs::set_permissions(path, Permissions::from_mode(0o600)).expect("FIFO mode");
    assert!(
        fs::symlink_metadata(path)
            .expect("FIFO metadata")
            .file_type()
            .is_fifo()
    );
}

fn snapshot_tree(root: &Path) -> Vec<TreeEntry> {
    fn visit(root: &Path, directory: &Path, output: &mut Vec<TreeEntry>) {
        let mut children: Vec<_> = fs::read_dir(directory)
            .expect("snapshot directory")
            .map(|entry| entry.expect("snapshot entry").path())
            .collect();
        children.sort();
        for child in children {
            let metadata = fs::symlink_metadata(&child).expect("snapshot metadata");
            let file_type = metadata.file_type();
            let payload = if file_type.is_file() {
                fs::read(&child).expect("snapshot file")
            } else if file_type.is_symlink() {
                fs::read_link(&child)
                    .expect("snapshot symlink")
                    .as_os_str()
                    .as_encoded_bytes()
                    .to_vec()
            } else {
                Vec::new()
            };
            output.push(TreeEntry {
                relative_name: child
                    .strip_prefix(root)
                    .expect("relative snapshot path")
                    .to_string_lossy()
                    .into_owned(),
                kind: if file_type.is_file() {
                    "file"
                } else if file_type.is_dir() {
                    "directory"
                } else if file_type.is_symlink() {
                    "symlink"
                } else {
                    "other"
                },
                mode: metadata.mode(),
                links: metadata.nlink(),
                size: metadata.size(),
                payload,
            });
            if file_type.is_dir() {
                visit(root, &child, output);
            }
        }
    }

    let root_metadata = fs::symlink_metadata(root).expect("snapshot root metadata");
    let mut entries = vec![TreeEntry {
        relative_name: ".".to_owned(),
        kind: "directory",
        mode: root_metadata.mode(),
        links: root_metadata.nlink(),
        size: root_metadata.size(),
        payload: Vec::new(),
    }];
    visit(root, root, &mut entries);
    entries.sort();
    entries
}

fn assert_fails_closed_without_repair(root: &Path, public_key: [u8; 32]) {
    let before = snapshot_tree(root);
    let metadata = fs::metadata(root).expect("root metadata");
    match open_store(root, public_key, metadata.uid(), metadata.gid()) {
        Err(OpenError::Root | OpenError::Lock) => {}
        Ok(store) => assert!(
            matches!(
                store.inspect(),
                Err(StorageError::Sealed | StorageError::Unavailable)
            ),
            "corrupt tree must not expose a verified snapshot"
        ),
    }
    assert_eq!(
        snapshot_tree(root),
        before,
        "verification must not repair, delete, rename, or rewrite corruption"
    );
}

#[test]
fn fixed_tree_extra_missing_and_renamed_entries_fail_closed_without_repair() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
    for mutation in [
        "extra-root",
        "extra-objects",
        "missing-format",
        "missing-lock",
        "missing-leaves",
        "renamed-transitions",
        "renamed-signatures",
    ] {
        let directory = new_tree();
        let root = directory.path();
        match mutation {
            "extra-root" => fs::write(root.join("unexpected"), b"x").expect("extra root entry"),
            "extra-objects" => {
                fs::write(root.join("objects/unexpected"), b"x").expect("extra object entry")
            }
            "missing-format" => fs::remove_file(root.join("FORMAT")).expect("remove format"),
            "missing-lock" => fs::remove_file(root.join("LOCK")).expect("remove lock"),
            "missing-leaves" => fs::remove_dir(root.join("objects/leaves")).expect("remove leaves"),
            "renamed-transitions" => {
                fs::rename(root.join("transitions"), root.join("transitions-old"))
                    .expect("rename transitions")
            }
            "renamed-signatures" => fs::rename(
                root.join("objects/signatures"),
                root.join("objects/signatures-old"),
            )
            .expect("rename signatures"),
            _ => unreachable!(),
        }
        assert_fails_closed_without_repair(root, public_key);
    }
}

#[test]
fn bad_format_lock_and_expected_owner_fail_before_state_is_available() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
    for mutation in ["format-content", "format-size", "lock-content"] {
        let directory = new_tree();
        let root = directory.path();
        match mutation {
            "format-content" => {
                let mut bytes = FORMAT_BYTES.to_vec();
                bytes[0] ^= 1;
                fs::write(root.join("FORMAT"), bytes).expect("bad format content");
            }
            "format-size" => fs::write(root.join("FORMAT"), b"short\n").expect("short format"),
            "lock-content" => fs::write(root.join("LOCK"), b"occupied").expect("nonempty lock"),
            _ => unreachable!(),
        }
        assert_fails_closed_without_repair(root, public_key);
    }

    let directory = new_tree();
    let root = directory.path();
    let metadata = fs::metadata(root).expect("root metadata");
    let before = snapshot_tree(root);
    let wrong_uid = metadata.uid().checked_add(1).unwrap_or(metadata.uid() - 1);
    let wrong_gid = metadata.gid().checked_add(1).unwrap_or(metadata.gid() - 1);
    assert!(matches!(
        open_store(root, public_key, wrong_uid, metadata.gid()),
        Err(OpenError::Root)
    ));
    assert!(matches!(
        open_store(root, public_key, metadata.uid(), wrong_gid),
        Err(OpenError::Root)
    ));
    assert_eq!(snapshot_tree(root), before);
}

#[test]
fn special_files_fail_closed_without_blocking_in_every_initial_read_namespace() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();
    for artifact in ["format", "lock", "leaf", "signature", "transition"] {
        let directory = new_tree();
        let root = directory.path();
        let path = match artifact {
            "format" => root.join("FORMAT"),
            "lock" => root.join("LOCK"),
            "leaf" => root.join("objects/leaves").join(digest('0')),
            "signature" => root.join("objects/signatures").join(digest('0')),
            "transition" => {
                root.join("transitions")
                    .join(format!("{:020}-{}.json", 1, digest('0')))
            }
            _ => unreachable!(),
        };
        replace_with_fifo(&path);
        let started = std::time::Instant::now();
        assert_fails_closed_without_repair(root, public_key);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{artifact} special file blocked the initial scanner"
        );
    }
}

#[test]
fn special_files_fail_revalidation_without_blocking() {
    for artifact in ["format", "lock", "leaf", "signature", "transition"] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        let metadata = fs::metadata(root).expect("root metadata");
        let store =
            open_store(root, public_key, metadata.uid(), metadata.gid()).expect("registered store");
        let path = match artifact {
            "format" => root.join("FORMAT"),
            "lock" => root.join("LOCK"),
            "leaf" => sole_file(root.join("objects/leaves")),
            "signature" => sole_file(root.join("objects/signatures")),
            "transition" => sole_file(root.join("transitions")),
            _ => unreachable!(),
        };
        replace_with_fifo(&path);
        let before = snapshot_tree(root);
        let started = std::time::Instant::now();
        assert!(store.revalidate_for_test().is_err());
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{artifact} special file blocked revalidation"
        );
        assert_eq!(
            snapshot_tree(root),
            before,
            "{artifact} revalidation must not repair or rewrite corruption"
        );
    }
}

#[test]
fn every_regular_artifact_executes_the_owner_mismatch_guard() {
    let (directory, public_key) = registered_tree();
    let root = directory.path();
    let metadata = fs::metadata(root).expect("root metadata");
    let store =
        open_store(root, public_key, metadata.uid(), metadata.gid()).expect("registered store");
    for artifact in ["format", "lock", "leaf", "signature", "transition"] {
        store
            .owner_mismatch_rejected_for_test(artifact)
            .unwrap_or_else(|()| panic!("{artifact} accepted the wrong owner"));
    }
}

#[test]
fn production_scanner_metadata_and_directory_guards_reject_a_real_mount_crossing() {
    let parent: OwnedFd = File::open("/dev").expect("open /dev").into();
    let parent_stat = fstat(&parent).expect("/dev stat");
    let child_stat = statat(&parent, c"shm", AtFlags::SYMLINK_NOFOLLOW).expect("/dev/shm stat");
    if parent_stat.st_dev == child_stat.st_dev {
        eprintln!("skipped: /dev/shm is not a distinct mount on this platform");
        return;
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
    let resolve_without_no_xdev =
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS;
    let control = openat2(
        &parent,
        c"shm",
        flags,
        Mode::empty(),
        resolve_without_no_xdev,
    )
    .expect("control open across demonstrated mount boundary");
    assert_ne!(
        fstat(&control).expect("control stat").st_dev,
        parent_stat.st_dev
    );
    assert!(guarded_metadata_open_for_test(&parent, c"shm").is_err());
    assert!(guarded_open_directory_for_test(&parent, c"shm").is_err());
}

#[test]
fn production_filesystem_guard_rejects_procfs() {
    let proc_fd: OwnedFd = File::open("/proc").expect("open /proc").into();
    assert_eq!(
        fstatfs(&proc_fd).expect("procfs statfs").f_type as u64,
        0x0000_9fa0
    );
    assert!(verify_local_filesystem_for_test(&proc_fd).is_err());
}

#[test]
fn object_filename_content_truncation_and_orphan_matrix_fails_closed() {
    for mutation in [
        "invalid-leaf-name",
        "invalid-signature-name",
        "leaf-content",
        "leaf-truncation",
        "signature-content",
        "signature-truncation",
        "missing-leaf",
        "missing-signature",
        "orphan-leaf",
        "orphan-signature",
    ] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        let leaf = sole_file(root.join("objects/leaves"));
        let signature = sole_file(root.join("objects/signatures"));
        match mutation {
            "invalid-leaf-name" => {
                fs::write(root.join("objects/leaves/not-a-digest"), b"x")
                    .expect("invalid leaf name");
                fs::set_permissions(
                    root.join("objects/leaves/not-a-digest"),
                    Permissions::from_mode(0o600),
                )
                .expect("invalid leaf mode");
            }
            "invalid-signature-name" => {
                let path = root.join("objects/signatures/not-a-digest");
                fs::write(&path, [0; 64]).expect("invalid signature name");
                fs::set_permissions(path, Permissions::from_mode(0o600))
                    .expect("invalid signature mode");
            }
            "leaf-content" => {
                let mut bytes = fs::read(&leaf).expect("leaf bytes");
                bytes[0] ^= 1;
                fs::write(&leaf, bytes).expect("alter leaf");
            }
            "leaf-truncation" => {
                let file = File::options()
                    .write(true)
                    .open(&leaf)
                    .expect("leaf writer");
                file.set_len(7).expect("truncate leaf");
            }
            "signature-content" => {
                let mut bytes = fs::read(&signature).expect("signature bytes");
                bytes[0] ^= 1;
                fs::write(&signature, bytes).expect("alter signature");
            }
            "signature-truncation" => {
                let file = File::options()
                    .write(true)
                    .open(&signature)
                    .expect("signature writer");
                file.set_len(63).expect("truncate signature");
            }
            "missing-leaf" => fs::remove_file(leaf).expect("remove referenced leaf"),
            "missing-signature" => fs::remove_file(signature).expect("remove referenced signature"),
            "orphan-leaf" => {
                let bytes = b"orphan-leaf\n";
                let path = root.join("objects/leaves").join(sha256_hex(bytes));
                fs::write(&path, bytes).expect("orphan leaf");
                fs::set_permissions(path, Permissions::from_mode(0o600)).expect("orphan leaf mode");
            }
            "orphan-signature" => {
                let bytes = [91; 64];
                let path = root.join("objects/signatures").join(sha256_hex(&bytes));
                fs::write(&path, bytes).expect("orphan signature");
                fs::set_permissions(path, Permissions::from_mode(0o600))
                    .expect("orphan signature mode");
            }
            _ => unreachable!(),
        }
        assert_fails_closed_without_repair(root, public_key);
    }
}

#[test]
fn transition_filename_content_gap_and_fork_matrix_fails_closed() {
    for mutation in [
        "invalid-name",
        "content-address",
        "truncation",
        "missing-transition",
        "gap",
        "duplicate-generation-fork",
    ] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        let transition = sole_file(root.join("transitions"));
        match mutation {
            "invalid-name" => {
                let path = root.join("transitions/unknown.json");
                fs::write(&path, b"unknown\n").expect("invalid transition name");
                fs::set_permissions(path, Permissions::from_mode(0o600))
                    .expect("invalid transition mode");
            }
            "content-address" => {
                let mut bytes = fs::read(&transition).expect("transition bytes");
                bytes[0] ^= 1;
                fs::write(&transition, bytes).expect("alter transition");
            }
            "truncation" => {
                let file = File::options()
                    .write(true)
                    .open(&transition)
                    .expect("transition writer");
                file.set_len(11).expect("truncate transition");
            }
            "missing-transition" => {
                fs::remove_file(&transition).expect("remove committed transition")
            }
            "gap" => {
                let name = transition
                    .file_name()
                    .expect("transition name")
                    .to_string_lossy();
                let renamed = format!("00000000000000000003{}", &name[20..]);
                fs::rename(&transition, root.join("transitions").join(renamed))
                    .expect("create generation gap");
            }
            "duplicate-generation-fork" => {
                let bytes = b"synthetic-fork\n";
                let name = format!("{:020}-{}.json", 1, sha256_hex(bytes));
                let path = root.join("transitions").join(name);
                fs::write(&path, bytes).expect("fork transition");
                fs::set_permissions(path, Permissions::from_mode(0o600))
                    .expect("fork transition mode");
            }
            _ => unreachable!(),
        }
        assert_fails_closed_without_repair(root, public_key);
    }
}

#[test]
fn permission_hard_link_and_symlink_matrix_fails_closed() {
    for mutation in [
        "root-mode",
        "objects-mode",
        "directory-mode",
        "signatures-directory-mode",
        "format-mode",
        "lock-mode",
        "leaf-mode",
        "signature-mode",
        "transition-mode",
    ] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        match mutation {
            "root-mode" => fs::set_permissions(root, Permissions::from_mode(0o750))
                .expect("root permission drift"),
            "objects-mode" => {
                fs::set_permissions(root.join("objects"), Permissions::from_mode(0o750))
                    .expect("objects permission drift")
            }
            "directory-mode" => {
                fs::set_permissions(root.join("objects/leaves"), Permissions::from_mode(0o750))
                    .expect("directory permission drift")
            }
            "signatures-directory-mode" => fs::set_permissions(
                root.join("objects/signatures"),
                Permissions::from_mode(0o750),
            )
            .expect("signatures directory permission drift"),
            "format-mode" => {
                fs::set_permissions(root.join("FORMAT"), Permissions::from_mode(0o640))
                    .expect("format permission drift")
            }
            "lock-mode" => fs::set_permissions(root.join("LOCK"), Permissions::from_mode(0o640))
                .expect("lock permission drift"),
            "leaf-mode" => fs::set_permissions(
                sole_file(root.join("objects/leaves")),
                Permissions::from_mode(0o640),
            )
            .expect("leaf permission drift"),
            "signature-mode" => fs::set_permissions(
                sole_file(root.join("objects/signatures")),
                Permissions::from_mode(0o640),
            )
            .expect("signature permission drift"),
            "transition-mode" => fs::set_permissions(
                sole_file(root.join("transitions")),
                Permissions::from_mode(0o640),
            )
            .expect("transition permission drift"),
            _ => unreachable!(),
        }
        assert_fails_closed_without_repair(root, public_key);
    }

    for artifact in ["format", "lock", "leaf", "signature", "transition"] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        let source = match artifact {
            "format" => root.join("FORMAT"),
            "lock" => root.join("LOCK"),
            "leaf" => sole_file(root.join("objects/leaves")),
            "signature" => sole_file(root.join("objects/signatures")),
            "transition" => sole_file(root.join("transitions")),
            _ => unreachable!(),
        };
        let link_holder = tempfile::tempdir().expect("hard-link holder");
        fs::hard_link(&source, link_holder.path().join(artifact)).expect("external hard link");
        assert_fails_closed_without_repair(root, public_key);
    }

    for artifact in [
        "objects",
        "leaves-directory",
        "signatures-directory",
        "transitions-directory",
        "format",
        "lock",
        "leaf",
        "signature",
        "transition",
    ] {
        let (directory, public_key) = registered_tree();
        let root = directory.path();
        let source = match artifact {
            "objects" => root.join("objects"),
            "leaves-directory" => root.join("objects/leaves"),
            "signatures-directory" => root.join("objects/signatures"),
            "transitions-directory" => root.join("transitions"),
            "format" => root.join("FORMAT"),
            "lock" => root.join("LOCK"),
            "leaf" => sole_file(root.join("objects/leaves")),
            "signature" => sole_file(root.join("objects/signatures")),
            "transition" => sole_file(root.join("transitions")),
            _ => unreachable!(),
        };
        let target_holder = tempfile::tempdir().expect("symlink target holder");
        let target = target_holder.path().join(artifact);
        fs::rename(&source, &target).expect("move entry outside fixed tree");
        symlink(&target, &source).expect("replace entry with symlink");
        assert_fails_closed_without_repair(root, public_key);
    }
}

#[test]
fn inventory_count_and_total_byte_caps_refuse_before_content_interpretation() {
    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let mut leaves = InventoryFiles::empty();
    leaves.leaves = (0..=MAX_LEAVES)
        .map(|index| (format!("{index:064x}"), vec![1]))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        verify_inventory(&leaves, &public_key),
        Err(JournalError::Limit)
    );

    let mut signatures = InventoryFiles::empty();
    signatures.signatures = (0..=MAX_SIGNATURES)
        .map(|index| (format!("{index:064x}"), vec![0; 64]))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        verify_inventory(&signatures, &public_key),
        Err(JournalError::Limit)
    );

    let mut transitions = InventoryFiles::empty();
    transitions.transitions = (1..=MAX_TRANSITIONS + 1)
        .map(|generation| {
            (
                generation as u64,
                TransitionFile {
                    digest: digest('0'),
                    bytes: vec![1],
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(
        verify_inventory(&transitions, &public_key),
        Err(JournalError::Limit)
    );

    let mut bytes = InventoryFiles::empty();
    bytes.leaves.insert(digest('0'), vec![0; MAX_TOTAL_BYTES]);
    assert_eq!(
        verify_inventory(&bytes, &public_key),
        Err(JournalError::Limit)
    );

    let mut oversized_object = InventoryFiles::empty();
    oversized_object
        .leaves
        .insert(digest('0'), vec![0; MAX_CANONICAL_BYTES + 1]);
    assert!(matches!(
        verify_inventory(&oversized_object, &public_key),
        Err(JournalError::Shape | JournalError::Limit)
    ));
}

#[test]
fn production_scanner_caps_precede_any_artifact_content_read() {
    const SPARSE_LEAF_COUNT: usize = 4_096;
    const SPARSE_LEAF_BYTES: usize = 16 * 1_024;
    const {
        assert!(MAX_TRANSITIONS == 4_096);
        assert!(MAX_CANONICAL_BYTES == SPARSE_LEAF_BYTES);
        assert!(SPARSE_LEAF_COUNT <= MAX_LEAVES);
        assert!(SPARSE_LEAF_COUNT * SPARSE_LEAF_BYTES == MAX_TOTAL_BYTES);
        assert!(!FORMAT_BYTES.is_empty());
    }

    let public_key = SyntheticRecordSigner::from_seed([7; 32]).public_key_bytes();

    let transition_directory = new_tree();
    for generation in 1..=MAX_TRANSITIONS + 1 {
        let digest = format!("{generation:064x}");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(
                transition_directory
                    .path()
                    .join("transitions")
                    .join(format!("{generation:020}-{digest}.json")),
            )
            .expect("sparse transition placeholder");
    }
    test_reset_artifact_content_reads();
    let metadata = fs::metadata(transition_directory.path()).expect("transition root metadata");
    let store = open_store(
        transition_directory.path(),
        public_key,
        metadata.uid(),
        metadata.gid(),
    )
    .expect("count-limited store opens sealed");
    assert_eq!(store.inspect(), Err(StorageError::Sealed));
    assert_eq!(
        test_artifact_content_reads(),
        0,
        "transition count must fail before artifact content reads"
    );
    drop(store);

    let byte_directory = new_tree();
    for index in 0..SPARSE_LEAF_COUNT {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(
                byte_directory
                    .path()
                    .join("objects/leaves")
                    .join(format!("{index:064x}")),
            )
            .expect("sparse leaf placeholder");
        file.set_len(SPARSE_LEAF_BYTES as u64)
            .expect("size sparse leaf placeholder");
    }
    test_reset_artifact_content_reads();
    let metadata = fs::metadata(byte_directory.path()).expect("byte root metadata");
    let store = open_store(
        byte_directory.path(),
        public_key,
        metadata.uid(),
        metadata.gid(),
    )
    .expect("byte-limited store opens sealed");
    assert_eq!(store.inspect(), Err(StorageError::Sealed));
    assert_eq!(
        test_artifact_content_reads(),
        0,
        "aggregate bytes must fail before artifact content reads"
    );
}
