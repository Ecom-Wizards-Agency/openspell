use sha2::{Digest as _, Sha256};

use std::fs::{File, Permissions, create_dir};
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt as _;
use std::process::{Command, Stdio};

use rustix::fs::{Mode, OFlags, open};

use crate::authority_registry::{inspect_bootstrap, inspect_policy};
use crate::authority_registry_tests::InstallationFixture;
use crate::super_lock::{
    ExpectedOwner, SUPER_LOCK_ACQUIRED_MARKER, create_and_lock, inspect_empty_root,
    test_set_super_lock_acquired_marker,
};
use crate::wp201_internal::{inspect_fresh_owned, inspect_legacy_v1_recovery_probe};

const PROCESS_ROLE: &str = "OPENSP_WP201_CROSS_ROLE";
const PROCESS_STATE: &str = "OPENSP_WP201_CROSS_STATE";
const PROCESS_POLICY: &str = "OPENSP_WP201_CROSS_POLICY";
const PROCESS_BOOTSTRAP: &str = "OPENSP_WP201_CROSS_BOOTSTRAP";
const PROCESS_OWNER: &str = "OPENSP_WP201_CROSS_OWNER";
const PROCESS_MARKER: &str = "OPENSP_WP201_CROSS_MARKER";

#[test]
fn feature_build_runs_the_immutable_v1_byte_and_classification_corpus() {
    // This test is compiled only in the feature build. The wrapper runs the unchanged v1
    // corpus once without the feature and once with it; pinning these goldens here makes any
    // feature-only byte/classification fork explicit rather than silently duplicating v1.
    let mut digest = Sha256::new();
    for bytes in [
        include_bytes!("grant-ticket-v1.golden.json").as_slice(),
        include_bytes!("transition-v1.golden.json").as_slice(),
    ] {
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    assert_eq!(
        hex::encode(digest.finalize()),
        "4fc8b1c3c3e862f3b69ca69f40be2d9460c62ac853db91384690c8de9f6e0141"
    );
}

#[test]
fn v2_domains_cannot_decode_as_v1_domains() {
    assert_ne!(
        crate::preparation_v2::FORMAT_BYTES,
        b"openspell.hosted-migration-root-authority.v1\n"
    );
    assert_ne!(
        crate::preparation_v2::INVENTORY_DOMAIN,
        b"openspell.hosted-migration-root-authority-inventory.v1\n"
    );
}

#[test]
fn preparation_and_legacy_recovery_share_one_super_lock_in_both_directions() {
    let preparation = InstallationFixture::new("openspell-wp201-cross-preparation-");
    let fresh = preparation.install_fresh();
    let before = tree_inventory(&preparation.state_path);
    run_cross_process_contender(&preparation, "legacy", false);
    assert_eq!(tree_inventory(&preparation.state_path), before);
    drop(fresh);
    run_cross_process_contender(&preparation, "legacy", true);

    let legacy = InstallationFixture::new("openspell-wp201-cross-legacy-");
    let root = open_dir(&legacy.state_path);
    let owner = inspect_empty_root(&root, ExpectedOwner::for_test(legacy.uid, legacy.gid))
        .expect("empty state root");
    let held = create_and_lock(root, owner).expect("create shared super-lock");
    create_empty_v1_journal(&legacy.state_path.join("ROOT_JOURNAL_V1"));
    create_dir(legacy.state_path.join("AUTHORITY_REGISTRY")).expect("inert registry directory");
    std::fs::set_permissions(
        legacy.state_path.join("AUTHORITY_REGISTRY"),
        Permissions::from_mode(0o700),
    )
    .expect("inert registry mode");
    drop(held);
    let probe = inspect_legacy_v1_recovery_probe(
        open_dir(&legacy.state_path),
        legacy.uid,
        legacy.gid,
        [7; 32],
    )
    .expect("legacy recovery holder");
    let before = tree_inventory(&legacy.state_path);
    run_cross_process_contender(&legacy, "preparation", false);
    assert_eq!(tree_inventory(&legacy.state_path), before);
    probe.release_staged_for_test(|stage| match stage {
        "journal" => assert!(
            inspect_legacy_v1_recovery_probe(
                open_dir(&legacy.state_path),
                legacy.uid,
                legacy.gid,
                [7; 32],
            )
            .is_err(),
            "super-lock remains held until outer state release"
        ),
        "state" => assert!(
            inspect_legacy_v1_recovery_probe(
                open_dir(&legacy.state_path),
                legacy.uid,
                legacy.gid,
                [7; 32],
            )
            .is_ok(),
            "outer state lock released last"
        ),
        _ => panic!("unknown release stage"),
    });
    run_cross_process_contender(&legacy, "preparation", true);
}

#[test]
fn wp201_cross_version_process_child() {
    let Some(role) = std::env::var_os(PROCESS_ROLE) else {
        return;
    };
    let state = std::path::PathBuf::from(std::env::var_os(PROCESS_STATE).expect("state"));
    let marker = std::path::PathBuf::from(std::env::var_os(PROCESS_MARKER).expect("marker"));
    test_set_super_lock_acquired_marker(move || {
        std::fs::write(marker, SUPER_LOCK_ACQUIRED_MARKER).expect("write acquisition marker");
    });
    let owner = std::env::var(PROCESS_OWNER).expect("owner");
    let (uid, gid) = owner.split_once(':').expect("owner tuple");
    let uid = uid.parse().expect("uid");
    let gid = gid.parse().expect("gid");
    match role.to_str().expect("role utf8") {
        "legacy" => {
            assert!(inspect_legacy_v1_recovery_probe(open_dir(&state), uid, gid, [7; 32]).is_err())
        }
        "preparation" => {
            let policy_path =
                std::path::PathBuf::from(std::env::var_os(PROCESS_POLICY).expect("policy"));
            let bootstrap_path =
                std::path::PathBuf::from(std::env::var_os(PROCESS_BOOTSTRAP).expect("bootstrap"));
            let policy = inspect_policy(open_file(&policy_path), ExpectedOwner::for_test(uid, gid))
                .expect("policy");
            let bootstrap = inspect_bootstrap(
                policy,
                open_dir(&bootstrap_path),
                ExpectedOwner::for_test(uid, gid),
            )
            .expect("bootstrap");
            assert!(inspect_fresh_owned(bootstrap, open_dir(&state), uid, gid).is_err());
        }
        _ => panic!("unknown role"),
    }
}

fn run_cross_process_contender(fixture: &InstallationFixture, role: &str, expect_acquired: bool) {
    let marker = fixture
        .policy_path
        .with_file_name(format!("cross-{role}-acquired"));
    let _ = std::fs::remove_file(&marker);
    let status = Command::new(std::env::current_exe().expect("test executable"))
        .arg("--exact")
        .arg("cross_version_tests::wp201_cross_version_process_child")
        .arg("--nocapture")
        .env(PROCESS_ROLE, role)
        .env(PROCESS_STATE, &fixture.state_path)
        .env(PROCESS_POLICY, &fixture.policy_path)
        .env(PROCESS_BOOTSTRAP, &fixture.bootstrap_path)
        .env(PROCESS_OWNER, format!("{}:{}", fixture.uid, fixture.gid))
        .env(PROCESS_MARKER, &marker)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("cross-process contender");
    assert!(status.success(), "cross-process contender {role}");
    if expect_acquired {
        assert_eq!(
            std::fs::read(&marker).expect("acquisition marker"),
            SUPER_LOCK_ACQUIRED_MARKER
        );
        std::fs::remove_file(&marker).expect("remove acquisition marker");
    } else {
        assert!(!marker.exists(), "lock acquisition marker must be absent");
    }
}

fn create_empty_v1_journal(path: &std::path::Path) {
    std::fs::create_dir(path).expect("journal root");
    for relative in [
        "objects",
        "objects/leaves",
        "objects/signatures",
        "transitions",
    ] {
        create_dir(path.join(relative)).expect("journal directory");
    }
    for relative in [
        "",
        "objects",
        "objects/leaves",
        "objects/signatures",
        "transitions",
    ] {
        std::fs::set_permissions(path.join(relative), Permissions::from_mode(0o700))
            .expect("directory mode");
    }
    std::fs::write(path.join("FORMAT"), crate::journal::FORMAT_BYTES).expect("format");
    File::create(path.join("LOCK")).expect("lock");
    for relative in ["FORMAT", "LOCK"] {
        std::fs::set_permissions(path.join(relative), Permissions::from_mode(0o600))
            .expect("file mode");
    }
}

fn open_dir(path: &std::path::Path) -> OwnedFd {
    open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .expect("directory")
}

fn open_file(path: &std::path::Path) -> OwnedFd {
    open(path, OFlags::RDONLY | OFlags::CLOEXEC, Mode::empty()).expect("file")
}

fn tree_inventory(root: &std::path::Path) -> Vec<(String, u64)> {
    fn visit(root: &std::path::Path, path: &std::path::Path, out: &mut Vec<(String, u64)>) {
        for entry in std::fs::read_dir(path).expect("inventory directory") {
            let entry = entry.expect("inventory entry");
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .expect("relative")
                .to_string_lossy()
                .into_owned();
            let metadata = entry.metadata().expect("metadata");
            out.push((relative, metadata.len()));
            if metadata.is_dir() {
                visit(root, &path, out);
            }
        }
    }
    let mut out = Vec::new();
    visit(root, root, &mut out);
    out.sort();
    out
}
