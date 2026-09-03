use std::collections::BTreeMap;
use std::fs::{self, File, Permissions};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use crate::canonical::MAX_CANONICAL_BYTES;
use crate::crypto::{RecordSigner, SyntheticRecordSigner, sha256_hex};
use crate::journal::storage::{
    HeadCas, JournalStore, OpenError, RegisterCommand, RootAuthority, StorageError, TicketEntropy,
    TrustedClock,
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

    let (directory, public_key) = registered_tree();
    let link_holder = tempfile::tempdir().expect("hard-link holder");
    fs::hard_link(
        directory.path().join("LOCK"),
        link_holder.path().join("lock-link"),
    )
    .expect("external hard link");
    assert_fails_closed_without_repair(directory.path(), public_key);

    let (directory, public_key) = registered_tree();
    let link_holder = tempfile::tempdir().expect("leaf hard-link holder");
    fs::hard_link(
        sole_file(directory.path().join("objects/leaves")),
        link_holder.path().join("leaf-link"),
    )
    .expect("external leaf hard link");
    assert_fails_closed_without_repair(directory.path(), public_key);

    let (directory, public_key) = registered_tree();
    let leaf = sole_file(directory.path().join("objects/leaves"));
    let target_holder = tempfile::tempdir().expect("symlink target holder");
    let target = target_holder.path().join("candidate");
    fs::rename(&leaf, &target).expect("move leaf outside fixed tree");
    symlink(&target, &leaf).expect("replace leaf with symlink");
    assert_fails_closed_without_repair(directory.path(), public_key);
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
