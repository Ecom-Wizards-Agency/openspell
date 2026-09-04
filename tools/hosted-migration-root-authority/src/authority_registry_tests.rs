use std::fs::{File, OpenOptions, create_dir, write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::{Command, Stdio};

use rustix::fs::{
    MemfdFlags, Mode, OFlags, SealFlags, fchmod, fcntl_add_seals, memfd_create, open,
};
use sha2::Digest as _;
use time::OffsetDateTime;

use crate::authority_registry::{
    BootstrapLease, build_bootstrap_fixture_record, build_installation_fixture,
    build_installation_fixture_with_duration, inspect_bootstrap, inspect_policy,
    inspect_registry_seed, registry_seed_pread_count, reset_registry_seed_pread_count,
    sample_clock,
};
use crate::journal::storage::{
    TestDirectoryBoundary, TestFaultPoint, TestPublicationBoundary, test_clear_fault,
    test_delay_at, test_fail_at, test_park_at, test_run_at,
};
use crate::super_lock::ExpectedOwner;
use crate::wp201_internal::{StateRootInstallationOutcomeV1, inspect_fresh_owned, install_owned};

const POLICY: &[u8] = include_bytes!("preparation-policy-v1.golden.json");
const BOOTSTRAP_FORMAT: &[u8] = b"openspell.synthetic-preparation-proof-bootstrap.v1\n";
const PROCESS_ROOT: &str = "OPENSP_WP201_TEST_ROOT";
const PROCESS_BOOTSTRAP: &str = "OPENSP_WP201_TEST_BOOTSTRAP";
const PROCESS_POLICY: &str = "OPENSP_WP201_TEST_POLICY";
const PROCESS_OWNER: &str = "OPENSP_WP201_TEST_OWNER";
const PROCESS_READY: &str = "OPENSP_WP201_TEST_READY";
const PROCESS_CUT: &str = "OPENSP_WP201_TEST_CUT";

#[test]
fn installs_and_recovers_exact_fresh_generation_one() {
    let fixture = tempfile::Builder::new()
        .prefix("openspell-wp201-step3-")
        .tempdir_in("/dev/shm")
        .expect("tmpfs fixture");
    let fixture_stat = rustix::fs::stat(fixture.path()).expect("fixture stat");
    let uid = fixture_stat.st_uid;
    let gid = fixture_stat.st_gid;
    chmod(fixture.path(), 0o700);
    let policy_path = fixture.path().join("policy");
    create_file(&policy_path, POLICY);
    let bootstrap_path = fixture.path().join("bootstrap");
    create_dir_mode(&bootstrap_path);
    build_bootstrap(&bootstrap_path, uid, gid);
    let state_path = fixture.path().join("state");
    create_dir_mode(&state_path);

    let policy = inspect_policy(open_read(&policy_path), owner(uid, gid)).expect("policy");
    let bootstrap =
        inspect_bootstrap(policy, open_dir(&bootstrap_path), owner(uid, gid)).expect("bootstrap");
    let (authorization, signature) = build_installation_fixture(
        &bootstrap,
        &open_dir(&state_path),
        uid,
        gid,
        OffsetDateTime::now_utc(),
    );
    let outcome = install_owned(
        bootstrap,
        open_dir(&state_path),
        registry_seed_memfd(),
        open_dir(Path::new("/proc")),
        &authorization,
        &signature,
        uid,
        gid,
    )
    .expect("installation");
    let fresh = match outcome {
        StateRootInstallationOutcomeV1::Installed(fresh) => fresh,
        StateRootInstallationOutcomeV1::CommitOutcomeUnknown => panic!("known installation"),
    };
    assert_eq!(fresh.generation_for_test(), 1);
    let competing_policy =
        inspect_policy(open_read(&policy_path), owner(uid, gid)).expect("second policy");
    let competing_bootstrap =
        inspect_bootstrap(competing_policy, open_dir(&bootstrap_path), owner(uid, gid))
            .expect("second bootstrap");
    assert!(inspect_fresh_owned(competing_bootstrap, open_dir(&state_path), uid, gid).is_err());
    drop(fresh);

    let policy = inspect_policy(open_read(&policy_path), owner(uid, gid)).expect("fresh policy");
    let bootstrap = inspect_bootstrap(policy, open_dir(&bootstrap_path), owner(uid, gid))
        .expect("fresh bootstrap");
    let recovered =
        inspect_fresh_owned(bootstrap, open_dir(&state_path), uid, gid).expect("fresh recovery");
    assert_eq!(recovered.generation_for_test(), 1);
    assert_eq!(
        sorted_names(&state_path),
        [
            "AUTHORITY_REGISTRY",
            "AUTHORITY_SUPER_LOCK",
            "PREPARATION_JOURNAL_V2",
        ]
    );
    assert!(!state_path.join("ROOT_JOURNAL_V1").exists());
    assert_eq!(
        sorted_names(&state_path.join("PREPARATION_JOURNAL_V2")),
        ["FORMAT", "LOCK", "objects", "transitions"]
    );
    assert_eq!(
        sorted_names(&state_path.join("PREPARATION_JOURNAL_V2/objects")),
        ["records", "signatures"]
    );
    assert!(sorted_names(&state_path.join("PREPARATION_JOURNAL_V2/objects/records")).is_empty());
    assert!(
        sorted_names(&state_path.join(["PREPARATION_JOURNAL_V2/objects", "signatures"].join("/")))
            .is_empty()
    );
    assert!(sorted_names(&state_path.join("PREPARATION_JOURNAL_V2/transitions")).is_empty());
    assert_eq!(
        sorted_names(&state_path.join("AUTHORITY_REGISTRY")),
        ["FORMAT", "objects", "transitions"]
    );
    assert_eq!(
        sorted_names(&state_path.join("AUTHORITY_REGISTRY/objects/records")).len(),
        2
    );
    assert_eq!(
        sorted_names(&state_path.join("AUTHORITY_REGISTRY/objects/signatures")).len(),
        2
    );
    assert_eq!(
        sorted_names(&state_path.join("AUTHORITY_REGISTRY/transitions")).len(),
        1
    );
}

#[test]
fn every_installation_artifact_cut_is_refusal_or_exactly_recoverable() {
    // 1-4 are the super-lock, v2 FORMAT/LOCK and registry FORMAT. 5-9 are the
    // exact five generation-one files required by the registry contract.
    for ordinal in 1..=9 {
        for boundary in [
            TestPublicationBoundary::FinalNameCreated,
            TestPublicationBoundary::PartialWrite,
            TestPublicationBoundary::CompleteWrite,
            TestPublicationBoundary::MetadataVerified,
            TestPublicationBoundary::FileSynced,
            TestPublicationBoundary::DirectorySynced,
        ] {
            if matches!(ordinal, 1 | 3) && boundary == TestPublicationBoundary::PartialWrite {
                continue;
            }
            let fixture = InstallationFixture::new("openspell-wp201-registry-cut-");
            let bootstrap = fixture.bootstrap();
            let (authorization, signature) = build_installation_fixture(
                &bootstrap,
                &open_dir(&fixture.state_path),
                fixture.uid,
                fixture.gid,
                OffsetDateTime::now_utc(),
            );
            test_fail_at(TestFaultPoint::Publication { ordinal, boundary });
            let outcome = install_owned(
                bootstrap,
                open_dir(&fixture.state_path),
                registry_seed_memfd(),
                open_dir(Path::new("/proc")),
                &authorization,
                &signature,
                fixture.uid,
                fixture.gid,
            );
            test_clear_fault();

            if ordinal < 9 {
                assert!(
                    outcome.is_err(),
                    "pre-transition cut {ordinal} {boundary:?}"
                );
                assert!(fixture.recover().is_err());
                continue;
            }
            assert!(
                matches!(
                    &outcome,
                    Ok(StateRootInstallationOutcomeV1::CommitOutcomeUnknown)
                ),
                "transition cut {boundary:?}: {}; transitions={:?}",
                outcome_kind(&outcome),
                sorted_names(&fixture.state_path.join("AUTHORITY_REGISTRY/transitions")),
            );
            let complete = matches!(
                boundary,
                TestPublicationBoundary::CompleteWrite
                    | TestPublicationBoundary::MetadataVerified
                    | TestPublicationBoundary::FileSynced
                    | TestPublicationBoundary::DirectorySynced
            );
            assert_eq!(
                fixture.recover().is_ok(),
                complete,
                "transition cut {boundary:?}"
            );
        }
    }
}

fn outcome_kind(
    outcome: &Result<StateRootInstallationOutcomeV1, crate::wp201_internal::PreparationRefusal>,
) -> &'static str {
    match outcome {
        Err(_) => "refusal",
        Ok(StateRootInstallationOutcomeV1::CommitOutcomeUnknown) => "unknown",
        Ok(StateRootInstallationOutcomeV1::Installed(_)) => "installed",
    }
}

#[test]
fn invalid_authorization_refuses_before_state_root_mutation() {
    let fixture = InstallationFixture::new("openspell-wp201-invalid-auth-");
    let bootstrap = fixture.bootstrap();
    let (authorization, mut signature) = build_installation_fixture(
        &bootstrap,
        &open_dir(&fixture.state_path),
        fixture.uid,
        fixture.gid,
        OffsetDateTime::now_utc(),
    );
    signature[0] ^= 1;
    assert!(
        install_owned(
            bootstrap,
            open_dir(&fixture.state_path),
            registry_seed_memfd(),
            open_dir(Path::new("/proc")),
            &authorization,
            &signature,
            fixture.uid,
            fixture.gid,
        )
        .is_err()
    );
    assert!(sorted_names(&fixture.state_path).is_empty());

    let expired = InstallationFixture::new("openspell-wp201-expired-auth-");
    let bootstrap = expired.bootstrap();
    let (authorization, signature) = build_installation_fixture_with_duration(
        &bootstrap,
        &open_dir(&expired.state_path),
        expired.uid,
        expired.gid,
        OffsetDateTime::now_utc() - time::Duration::seconds(2),
        1,
    );
    assert!(
        expired
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    assert!(sorted_names(&expired.state_path).is_empty());

    let future = InstallationFixture::new("openspell-wp201-future-auth-");
    let bootstrap = future.bootstrap();
    let (authorization, signature) = build_installation_fixture_with_duration(
        &bootstrap,
        &open_dir(&future.state_path),
        future.uid,
        future.gid,
        OffsetDateTime::now_utc() + time::Duration::seconds(60),
        240,
    );
    assert!(
        future
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    assert!(sorted_names(&future.state_path).is_empty());
}

#[test]
fn bootstrap_lease_retains_its_shared_ofd_lock() {
    let fixture = InstallationFixture::new("openspell-wp201-bootstrap-lock-");
    let lease = fixture.bootstrap();
    let contender: OwnedFd = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.bootstrap_path.join("LOCK"))
        .expect("contender lock")
        .into();
    assert!(crate::journal::storage::acquire_ofd_lock(&contender).is_err());
    drop(lease);
    crate::journal::storage::acquire_ofd_lock(&contender).expect("exclusive lock after lease drop");
}

#[test]
fn policy_refuses_byte_and_descriptor_drift() {
    let fixture = tempfile::Builder::new()
        .prefix("openspell-wp201-policy-")
        .tempdir_in("/dev/shm")
        .expect("tmpfs fixture");
    let fixture_stat = rustix::fs::stat(fixture.path()).expect("fixture stat");
    let uid = fixture_stat.st_uid;
    let gid = fixture_stat.st_gid;
    let valid = fixture.path().join("valid");
    create_file(&valid, POLICY);
    assert!(inspect_policy(open_read(&valid), owner(uid, gid)).is_ok());
    let changed = fixture.path().join("changed");
    let mut bytes = POLICY.to_vec();
    bytes[10] ^= 1;
    create_file(&changed, &bytes);
    assert!(inspect_policy(open_read(&changed), owner(uid, gid)).is_err());
    let writable = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&valid)
        .expect("writable");
    assert!(inspect_policy(writable.into(), owner(uid, gid)).is_err());
}

#[test]
fn registry_seed_is_consumed_by_exactly_one_pread() {
    reset_registry_seed_pread_count();
    let valid = registry_seed_memfd();
    let stat = rustix::fs::fstat(&valid).expect("seed stat");
    assert!(inspect_registry_seed(valid, owner(stat.st_uid, stat.st_gid)).is_ok());
    assert_eq!(registry_seed_pread_count(), 1);

    reset_registry_seed_pread_count();
    let wrong = registry_seed_memfd_with(&[0x59; 32]);
    let stat = rustix::fs::fstat(&wrong).expect("seed stat");
    assert!(inspect_registry_seed(wrong, owner(stat.st_uid, stat.st_gid)).is_err());
    assert_eq!(registry_seed_pread_count(), 1);

    reset_registry_seed_pread_count();
    let short = registry_seed_memfd_with(&[0x5a; 31]);
    let stat = rustix::fs::fstat(&short).expect("seed stat");
    assert!(inspect_registry_seed(short, owner(stat.st_uid, stat.st_gid)).is_err());
    assert_eq!(
        registry_seed_pread_count(),
        0,
        "metadata refusal precedes seed read"
    );
}

#[test]
fn pre_first_child_cut_is_retryable_but_pre_transition_cut_is_not() {
    let retryable = InstallationFixture::new("openspell-wp201-before-child-");
    let bootstrap = retryable.bootstrap();
    let (authorization, signature) = retryable.authorization(&bootstrap);
    test_fail_at(TestFaultPoint::BeforeFirstPublication);
    assert!(
        retryable
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    test_clear_fault();
    assert!(sorted_names(&retryable.state_path).is_empty());
    let bootstrap = retryable.bootstrap();
    let (authorization, signature) = retryable.authorization(&bootstrap);
    assert!(matches!(
        retryable.install(bootstrap, &authorization, &signature),
        Ok(StateRootInstallationOutcomeV1::Installed(_))
    ));

    let stranded = InstallationFixture::new("openspell-wp201-before-transition-");
    let bootstrap = stranded.bootstrap();
    let (authorization, signature) = stranded.authorization(&bootstrap);
    test_fail_at(TestFaultPoint::RegistryBeforeFinalCreate);
    assert!(
        stranded
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    test_clear_fault();
    assert!(sorted_names(&stranded.state_path.join("AUTHORITY_REGISTRY/transitions")).is_empty());
    assert!(stranded.recover().is_err());
}

#[test]
fn post_durability_reopen_cut_is_unknown_and_recoverable() {
    let fixture = InstallationFixture::new("openspell-wp201-post-reopen-");
    let bootstrap = fixture.bootstrap();
    let (authorization, signature) = fixture.authorization(&bootstrap);
    test_fail_at(TestFaultPoint::RegistryPostDurability);
    assert!(matches!(
        fixture.install(bootstrap, &authorization, &signature),
        Ok(StateRootInstallationOutcomeV1::CommitOutcomeUnknown)
    ));
    test_clear_fault();
    assert!(fixture.recover().is_ok());
}

#[test]
fn pending_and_retained_registry_capabilities_reject_same_byte_replacement() {
    for replace_directory in [false, true] {
        let fixture = InstallationFixture::new("openspell-wp201-pending-replace-");
        let bootstrap = fixture.bootstrap();
        let (authorization, signature) = fixture.authorization(&bootstrap);
        let registry = fixture.state_path.join("AUTHORITY_REGISTRY");
        test_run_at(TestFaultPoint::RegistryBeforeFinalValidation, move || {
            if replace_directory {
                replace_directory_same_bytes(&registry.join("objects/records"));
            } else {
                replace_file_same_bytes(&registry.join("FORMAT"));
            }
        });
        assert!(
            fixture
                .install(bootstrap, &authorization, &signature)
                .is_err(),
            "pending graph replacement must refuse"
        );
        test_clear_fault();
        assert!(
            sorted_names(&fixture.state_path.join("AUTHORITY_REGISTRY/transitions")).is_empty()
        );
    }

    for replace_directory in [false, true] {
        let fixture = InstallationFixture::new("openspell-wp201-held-replace-");
        let fresh = fixture.install_fresh();
        let registry = fixture.state_path.join("AUTHORITY_REGISTRY");
        if replace_directory {
            replace_directory_same_bytes(&registry.join("objects/records"));
        } else {
            replace_file_same_bytes(&registry.join("FORMAT"));
        }
        assert!(fresh.revalidate_for_test().is_err());
    }
}

#[test]
fn retained_input_directories_require_read_only_directory_cloexec_custody() {
    let bootstrap_fixture = InstallationFixture::new("openspell-wp201-bootstrap-flags-");
    let policy = inspect_policy(
        open_read(&bootstrap_fixture.policy_path),
        owner(bootstrap_fixture.uid, bootstrap_fixture.gid),
    )
    .expect("policy");
    let bootstrap_root = open_dir(&bootstrap_fixture.bootstrap_path);
    nix::fcntl::fcntl(
        &bootstrap_root,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::empty()),
    )
    .expect("clear bootstrap cloexec");
    assert!(
        inspect_bootstrap(
            policy,
            bootstrap_root,
            owner(bootstrap_fixture.uid, bootstrap_fixture.gid),
        )
        .is_err()
    );

    let state_fixture = InstallationFixture::new("openspell-wp201-state-flags-");
    let bootstrap = state_fixture.bootstrap();
    let (authorization, signature) = state_fixture.authorization(&bootstrap);
    let state_root = open_dir(&state_fixture.state_path);
    nix::fcntl::fcntl(
        &state_root,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::empty()),
    )
    .expect("clear state cloexec");
    assert!(
        install_owned(
            bootstrap,
            state_root,
            registry_seed_memfd(),
            open_dir(Path::new("/proc")),
            &authorization,
            &signature,
            state_fixture.uid,
            state_fixture.gid,
        )
        .is_err()
    );
    assert!(sorted_names(&state_fixture.state_path).is_empty());

    let append_fixture = InstallationFixture::new("openspell-wp201-state-append-");
    let append_root = open(
        &append_fixture.state_path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::APPEND,
        Mode::empty(),
    )
    .expect("append directory descriptor");
    assert!(
        crate::super_lock::inspect_empty_root(
            &append_root,
            owner(append_fixture.uid, append_fixture.gid),
        )
        .is_err()
    );
}

#[test]
fn deadline_is_linearized_by_the_last_check_before_final_create() {
    let fixture = InstallationFixture::new("openspell-wp201-deadline-linearization-");
    let bootstrap = fixture.bootstrap();
    let (authorization, signature) = build_installation_fixture_with_duration(
        &bootstrap,
        &open_dir(&fixture.state_path),
        fixture.uid,
        fixture.gid,
        OffsetDateTime::now_utc(),
        3,
    );
    test_delay_at(
        TestFaultPoint::RegistryBeforeFinalCreate,
        std::time::Duration::from_millis(3_200),
    );
    assert!(matches!(
        fixture.install(bootstrap, &authorization, &signature),
        Ok(StateRootInstallationOutcomeV1::Installed(_))
    ));
    test_clear_fault();
}

#[test]
fn every_directory_creation_and_parent_sync_cut_is_recovery_only() {
    for ordinal in 1..=10 {
        for boundary in [
            TestDirectoryBoundary::Created,
            TestDirectoryBoundary::ParentSynced,
        ] {
            let fixture = InstallationFixture::new("openspell-wp201-directory-cut-");
            let bootstrap = fixture.bootstrap();
            let (authorization, signature) = fixture.authorization(&bootstrap);
            test_fail_at(TestFaultPoint::Directory { ordinal, boundary });
            assert!(
                fixture
                    .install(bootstrap, &authorization, &signature)
                    .is_err(),
                "directory cut {ordinal} {boundary:?}"
            );
            test_clear_fault();
            assert!(
                fixture.recover().is_err(),
                "directory cut recovered unexpectedly"
            );
        }
    }
}

#[test]
fn fresh_capability_releases_inner_locks_before_outer_locks() {
    let fixture = InstallationFixture::new("openspell-wp201-release-order-");
    let bootstrap = fixture.bootstrap();
    let (authorization, signature) = fixture.authorization(&bootstrap);
    let fresh = match fixture
        .install(bootstrap, &authorization, &signature)
        .expect("install")
    {
        StateRootInstallationOutcomeV1::Installed(fresh) => fresh,
        StateRootInstallationOutcomeV1::CommitOutcomeUnknown => panic!("known install"),
    };
    let journal: OwnedFd = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.state_path.join("PREPARATION_JOURNAL_V2/LOCK"))
        .expect("journal contender")
        .into();
    let state: OwnedFd = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.state_path.join("AUTHORITY_SUPER_LOCK"))
        .expect("state contender")
        .into();
    let bootstrap: OwnedFd = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.bootstrap_path.join("LOCK"))
        .expect("bootstrap contender")
        .into();
    fresh.release_staged_for_test(|stage| match stage {
        "registry" => {
            assert!(crate::journal::storage::acquire_ofd_lock(&journal).is_err());
            assert!(crate::journal::storage::acquire_ofd_lock(&state).is_err());
            assert!(crate::journal::storage::acquire_ofd_lock(&bootstrap).is_err());
        }
        "journal" => {
            crate::journal::storage::acquire_ofd_lock(&journal).expect("journal released");
            assert!(crate::journal::storage::acquire_ofd_lock(&state).is_err());
            assert!(crate::journal::storage::acquire_ofd_lock(&bootstrap).is_err());
        }
        "state" => {
            crate::journal::storage::acquire_ofd_lock(&state).expect("state released");
            assert!(crate::journal::storage::acquire_ofd_lock(&bootstrap).is_err());
        }
        "bootstrap" => {
            crate::journal::storage::acquire_ofd_lock(&bootstrap).expect("bootstrap released");
        }
        _ => panic!("unknown release stage"),
    });
}

#[test]
fn fresh_recovery_refuses_extra_orphan_gap_and_lock_replacement() {
    let extra = InstallationFixture::new("openspell-wp201-extra-");
    drop(extra.install_fresh());
    create_file(
        &extra
            .state_path
            .join("AUTHORITY_REGISTRY/objects/records")
            .join("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),
        b"{}\n",
    );
    assert!(extra.recover().is_err());

    let orphan = InstallationFixture::new("openspell-wp201-orphan-");
    drop(orphan.install_fresh());
    create_file(
        &orphan
            .state_path
            .join("AUTHORITY_REGISTRY/objects/signatures")
            .join("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
        &[0; 64],
    );
    assert!(orphan.recover().is_err());

    let fork = InstallationFixture::new("openspell-wp201-fork-");
    drop(fork.install_fresh());
    let transitions = fork.state_path.join("AUTHORITY_REGISTRY/transitions");
    create_file(
        &transitions.join(concat!(
            "00000000000000000001-",
            "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
            ".json"
        )),
        b"{}\n",
    );
    assert!(fork.recover().is_err());

    let gap = InstallationFixture::new("openspell-wp201-gap-");
    drop(gap.install_fresh());
    let transitions = gap.state_path.join("AUTHORITY_REGISTRY/transitions");
    let original = sorted_names(&transitions).pop().expect("transition");
    let replacement = format!("00000000000000000002-{}", &original[21..]);
    std::fs::rename(transitions.join(original), transitions.join(replacement)).expect("gap rename");
    assert!(gap.recover().is_err());

    let replaced = InstallationFixture::new("openspell-wp201-replaced-lock-");
    drop(replaced.install_fresh());
    let lock = replaced.state_path.join("AUTHORITY_SUPER_LOCK");
    std::fs::rename(&lock, replaced.state_path.with_file_name("old-state-lock"))
        .expect("move lock");
    create_file(&lock, b"");
    assert!(replaced.recover().is_err());
}

#[test]
fn bootstrap_path_replacement_and_non_procfs_clock_refuse_before_first_child() {
    let bootstrap_replaced = InstallationFixture::new("openspell-wp201-bootstrap-replace-");
    let bootstrap = bootstrap_replaced.bootstrap();
    let (authorization, signature) = bootstrap_replaced.authorization(&bootstrap);
    let lock = bootstrap_replaced.bootstrap_path.join("LOCK");
    std::fs::rename(
        &lock,
        bootstrap_replaced
            .bootstrap_path
            .with_file_name("old-bootstrap-lock"),
    )
    .expect("move bootstrap lock");
    create_file(&lock, b"");
    assert!(
        bootstrap_replaced
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    assert!(sorted_names(&bootstrap_replaced.state_path).is_empty());

    let bad_clock = InstallationFixture::new("openspell-wp201-bad-clock-");
    let bootstrap = bad_clock.bootstrap();
    let (authorization, signature) = bad_clock.authorization(&bootstrap);
    assert!(
        install_owned(
            bootstrap,
            open_dir(&bad_clock.state_path),
            registry_seed_memfd(),
            open_dir(&bad_clock.state_path),
            &authorization,
            &signature,
            bad_clock.uid,
            bad_clock.gid,
        )
        .is_err()
    );
    assert!(sorted_names(&bad_clock.state_path).is_empty());

    let procfs = open_dir(Path::new("/proc"));
    nix::fcntl::fcntl(
        &procfs,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::empty()),
    )
    .expect("clear cloexec");
    assert!(sample_clock(&procfs).is_err());
}

#[test]
fn every_retained_lock_refuses_nonzero_size() {
    let super_lock = InstallationFixture::new("openspell-wp201-super-size-");
    drop(super_lock.install_fresh());
    write(super_lock.state_path.join("AUTHORITY_SUPER_LOCK"), b"x").expect("write lock");
    assert!(super_lock.recover().is_err());

    let journal_lock = InstallationFixture::new("openspell-wp201-journal-size-");
    drop(journal_lock.install_fresh());
    write(
        journal_lock.state_path.join("PREPARATION_JOURNAL_V2/LOCK"),
        b"x",
    )
    .expect("write lock");
    assert!(journal_lock.recover().is_err());

    let bootstrap_lock = InstallationFixture::new("openspell-wp201-bootstrap-size-");
    let bootstrap = bootstrap_lock.bootstrap();
    let (authorization, signature) = bootstrap_lock.authorization(&bootstrap);
    write(bootstrap_lock.bootstrap_path.join("LOCK"), b"x").expect("write lock");
    assert!(
        bootstrap_lock
            .install(bootstrap, &authorization, &signature)
            .is_err()
    );
    assert!(sorted_names(&bootstrap_lock.state_path).is_empty());
}

#[test]
fn process_death_releases_fresh_state_ofd_locks_for_exact_recovery() {
    let fixture = InstallationFixture::new("openspell-wp201-process-death-");
    drop(fixture.install_fresh());
    let ready = fixture._root.path().join("ready");
    let owner = format!("{}:{}", fixture.uid, fixture.gid);
    let mut child = Command::new(std::env::current_exe().expect("test executable"))
        .arg("--exact")
        .arg("authority_registry_tests::wp201_fresh_process_child")
        .arg("--nocapture")
        .env(PROCESS_ROOT, &fixture.state_path)
        .env(PROCESS_BOOTSTRAP, &fixture.bootstrap_path)
        .env(PROCESS_POLICY, &fixture.policy_path)
        .env(PROCESS_OWNER, owner)
        .env(PROCESS_READY, &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lock holder");
    for _ in 0..250 {
        if ready.exists() {
            break;
        }
        if let Some(status) = child.try_wait().expect("child status") {
            panic!("lock holder exited before ready: {status}");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let ready_observed = ready.exists();
    let contention_observed = ready_observed && fixture.recover().is_err();
    if child
        .try_wait()
        .expect("child status after observation")
        .is_none()
    {
        child.kill().expect("kill holder");
    }
    let _ = child.wait().expect("reap holder");
    assert!(ready_observed, "child lock holder ready");
    assert!(contention_observed, "contender must observe OFD contention");
    assert!(
        fixture.recover().is_ok(),
        "process death releases all OFD locks"
    );
}

#[test]
fn abrupt_installation_process_loss_has_stable_exact_recovery_classification() {
    for (cut, recoverable) in [
        ("before-first", true),
        ("authorization-record-partial", false),
        ("before-final", false),
        ("final-partial", false),
        ("final-complete", true),
        ("post-durability", true),
    ] {
        let fixture = InstallationFixture::new("openspell-wp201-hard-cut-");
        let ready = fixture._root.path().join(format!("ready-{cut}"));
        let owner = format!("{}:{}", fixture.uid, fixture.gid);
        let child = Command::new(std::env::current_exe().expect("test executable"))
            .arg("--exact")
            .arg("authority_registry_tests::wp201_fresh_process_child")
            .arg("--nocapture")
            .env(PROCESS_ROOT, &fixture.state_path)
            .env(PROCESS_BOOTSTRAP, &fixture.bootstrap_path)
            .env(PROCESS_POLICY, &fixture.policy_path)
            .env(PROCESS_OWNER, owner)
            .env(PROCESS_READY, &ready)
            .env(PROCESS_CUT, cut)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cut child");
        let mut child = ChildGuard::new(child);
        await_child_ready(&mut child, &ready);
        child.terminate_and_reap().expect("terminate cut child");

        if cut == "before-first" {
            assert!(sorted_names(&fixture.state_path).is_empty());
            drop(fixture.install_fresh());
            continue;
        }
        assert_eq!(
            sorted_names(&fixture.state_path),
            [
                "AUTHORITY_REGISTRY",
                "AUTHORITY_SUPER_LOCK",
                "PREPARATION_JOURNAL_V2",
            ]
        );
        let transitions = fixture.state_path.join("AUTHORITY_REGISTRY/transitions");
        let transition_names = sorted_names(&transitions);
        match cut {
            "authorization-record-partial" | "before-final" => {
                assert!(transition_names.is_empty())
            }
            "final-partial" => {
                assert_eq!(transition_names.len(), 1);
                assert_eq!(
                    std::fs::metadata(transitions.join(&transition_names[0]))
                        .expect("partial transition")
                        .len(),
                    7
                );
            }
            "final-complete" | "post-durability" => {
                assert_eq!(transition_names.len(), 1);
                let path = transitions.join(&transition_names[0]);
                let bytes = std::fs::read(&path).expect("complete transition");
                assert!(bytes.len() > 7);
                assert_eq!(
                    &transition_names[0][21..85],
                    hex::encode(sha2::Sha256::digest(&bytes))
                );
            }
            _ => panic!("unknown cut"),
        }
        assert_eq!(fixture.recover().is_ok(), recoverable, "cut {cut}");
    }
}

#[test]
fn concurrent_installers_have_one_super_lock_winner() {
    let fixture = InstallationFixture::new("openspell-wp201-install-race-");
    let attempts: Vec<_> = (0..2)
        .map(|_| {
            let bootstrap = fixture.bootstrap();
            let (authorization, signature) = fixture.authorization(&bootstrap);
            (bootstrap, authorization, signature)
        })
        .collect();
    let winners = std::thread::scope(|scope| {
        let fixture = &fixture;
        attempts
            .into_iter()
            .map(|(bootstrap, authorization, signature)| {
                scope.spawn(move || {
                    usize::from(matches!(
                        fixture.install(bootstrap, &authorization, &signature),
                        Ok(StateRootInstallationOutcomeV1::Installed(_))
                    ))
                })
            })
            .map(|thread| thread.join().expect("installer contender"))
            .sum::<usize>()
    });
    assert_eq!(winners, 1);
    assert!(fixture.recover().is_ok());
}

#[test]
fn wp201_fresh_process_child() {
    let Some(state) = std::env::var_os(PROCESS_ROOT) else {
        return;
    };
    let bootstrap_path =
        std::path::PathBuf::from(std::env::var_os(PROCESS_BOOTSTRAP).expect("bootstrap path"));
    let policy_path = std::path::PathBuf::from(std::env::var_os(PROCESS_POLICY).expect("policy"));
    let owner = std::env::var(PROCESS_OWNER).expect("owner");
    let (uid, gid) = owner.split_once(':').expect("owner tuple");
    let uid = uid.parse().expect("uid");
    let gid = gid.parse().expect("gid");
    let policy =
        inspect_policy(open_read(&policy_path), ExpectedOwner::for_test(uid, gid)).expect("policy");
    let bootstrap = inspect_bootstrap(
        policy,
        open_dir(&bootstrap_path),
        ExpectedOwner::for_test(uid, gid),
    )
    .expect("bootstrap");
    if let Some(cut) = std::env::var_os(PROCESS_CUT) {
        let cut = cut.to_str().expect("cut utf8");
        let point = match cut {
            "before-first" => TestFaultPoint::BeforeFirstPublication,
            "authorization-record-partial" => TestFaultPoint::Publication {
                ordinal: 6,
                boundary: TestPublicationBoundary::PartialWrite,
            },
            "before-final" => TestFaultPoint::RegistryBeforeFinalCreate,
            "final-partial" => TestFaultPoint::Publication {
                ordinal: 9,
                boundary: TestPublicationBoundary::PartialWrite,
            },
            "final-complete" => TestFaultPoint::Publication {
                ordinal: 9,
                boundary: TestPublicationBoundary::CompleteWrite,
            },
            "post-durability" => TestFaultPoint::RegistryPostDurability,
            _ => panic!("unknown cut"),
        };
        let ready = std::path::PathBuf::from(std::env::var_os(PROCESS_READY).expect("ready path"));
        test_park_at(point, move || {
            write(&ready, b"ready\n").expect("ready");
        });
        let state_path = Path::new(&state);
        let (authorization, signature) = build_installation_fixture(
            &bootstrap,
            &open_dir(state_path),
            uid,
            gid,
            OffsetDateTime::now_utc(),
        );
        let _ = install_owned(
            bootstrap,
            open_dir(state_path),
            registry_seed_memfd(),
            open_dir(Path::new("/proc")),
            &authorization,
            &signature,
            uid,
            gid,
        );
        panic!("cut child did not park");
    }
    let fresh = inspect_fresh_owned(bootstrap, open_dir(Path::new(&state)), uid, gid)
        .expect("fresh lock holder");
    write(
        std::env::var_os(PROCESS_READY).expect("ready path"),
        b"ready\n",
    )
    .expect("ready");
    std::thread::sleep(std::time::Duration::from_secs(30));
    drop(fresh);
}

struct ChildGuard {
    child: Option<std::process::Child>,
}

impl ChildGuard {
    fn new(child: std::process::Child) -> Self {
        Self { child: Some(child) }
    }

    fn child_mut(&mut self) -> &mut std::process::Child {
        self.child.as_mut().expect("live child guard")
    }

    fn terminate_and_reap(&mut self) -> std::io::Result<()> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
        }
        child.wait()?;
        Ok(())
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.terminate_and_reap();
    }
}

fn await_child_ready(child: &mut ChildGuard, ready: &Path) {
    for _ in 0..250 {
        if ready.exists() {
            return;
        }
        if let Some(status) = child.child_mut().try_wait().expect("child status") {
            panic!("child exited before ready: {status}");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("child readiness timeout");
}

pub(crate) struct InstallationFixture {
    _root: tempfile::TempDir,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) policy_path: std::path::PathBuf,
    pub(crate) bootstrap_path: std::path::PathBuf,
    pub(crate) state_path: std::path::PathBuf,
}

impl InstallationFixture {
    pub(crate) fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in("/dev/shm")
            .expect("tmpfs fixture");
        let stat = rustix::fs::stat(root.path()).expect("fixture stat");
        chmod(root.path(), 0o700);
        let policy_path = root.path().join("policy");
        create_file(&policy_path, POLICY);
        let bootstrap_path = root.path().join("bootstrap");
        create_dir_mode(&bootstrap_path);
        build_bootstrap(&bootstrap_path, stat.st_uid, stat.st_gid);
        let state_path = root.path().join("state");
        create_dir_mode(&state_path);
        Self {
            _root: root,
            uid: stat.st_uid,
            gid: stat.st_gid,
            policy_path,
            bootstrap_path,
            state_path,
        }
    }

    pub(crate) fn bootstrap(&self) -> BootstrapLease {
        let policy = inspect_policy(open_read(&self.policy_path), owner(self.uid, self.gid))
            .expect("policy");
        inspect_bootstrap(
            policy,
            open_dir(&self.bootstrap_path),
            owner(self.uid, self.gid),
        )
        .expect("bootstrap")
    }

    pub(crate) fn recover(
        &self,
    ) -> Result<
        crate::wp201_internal::FreshPreparationStateRootV1,
        crate::wp201_internal::PreparationRefusal,
    > {
        inspect_fresh_owned(
            self.bootstrap(),
            open_dir(&self.state_path),
            self.uid,
            self.gid,
        )
    }

    fn authorization(&self, bootstrap: &BootstrapLease) -> (Vec<u8>, [u8; 64]) {
        build_installation_fixture(
            bootstrap,
            &open_dir(&self.state_path),
            self.uid,
            self.gid,
            OffsetDateTime::now_utc(),
        )
    }

    fn install(
        &self,
        bootstrap: BootstrapLease,
        authorization: &[u8],
        signature: &[u8; 64],
    ) -> Result<StateRootInstallationOutcomeV1, crate::wp201_internal::PreparationRefusal> {
        install_owned(
            bootstrap,
            open_dir(&self.state_path),
            registry_seed_memfd(),
            open_dir(Path::new("/proc")),
            authorization,
            signature,
            self.uid,
            self.gid,
        )
    }

    pub(crate) fn install_fresh(&self) -> crate::wp201_internal::FreshPreparationStateRootV1 {
        let bootstrap = self.bootstrap();
        let (authorization, signature) = self.authorization(&bootstrap);
        match self
            .install(bootstrap, &authorization, &signature)
            .expect("install")
        {
            StateRootInstallationOutcomeV1::Installed(fresh) => fresh,
            StateRootInstallationOutcomeV1::CommitOutcomeUnknown => panic!("known installation"),
        }
    }
}

fn owner(uid: u32, gid: u32) -> ExpectedOwner {
    ExpectedOwner::for_test(uid, gid)
}

fn build_bootstrap(root: &Path, uid: u32, gid: u32) {
    create_file(&root.join("FORMAT"), BOOTSTRAP_FORMAT);
    create_file(&root.join("LOCK"), b"");
    let objects = root.join("objects");
    create_dir_mode(&objects);
    let records = objects.join("records");
    let signatures = objects.join("signatures");
    create_dir_mode(&records);
    create_dir_mode(&signatures);
    let lock = open_read(&root.join("LOCK"));
    let activated = crate::authority_registry::render_millisecond(OffsetDateTime::now_utc())
        .expect("activated");
    let (record, signature) = build_bootstrap_fixture_record(&lock, uid, gid, &activated);
    let record_sha = hex::encode(sha2::Sha256::digest(&record));
    let signature_sha = hex::encode(sha2::Sha256::digest(signature));
    create_file(&records.join(&record_sha), &record);
    create_file(&signatures.join(signature_sha), &signature);
    create_file(&root.join("CURRENT"), format!("{record_sha}\n").as_bytes());
}

fn registry_seed_memfd() -> OwnedFd {
    registry_seed_memfd_with(&[0x5a; 32])
}

fn registry_seed_memfd_with(bytes: &[u8]) -> OwnedFd {
    let fd = memfd_create(
        "openspell-wp201-registry-test",
        MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
    )
    .expect("memfd");
    fchmod(&fd, Mode::RUSR | Mode::WUSR).expect("memfd mode");
    let mut written = 0;
    while written < bytes.len() {
        written += rustix::io::write(&fd, &bytes[written..]).expect("seed write");
    }
    fcntl_add_seals(
        &fd,
        SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL,
    )
    .expect("seals");
    fd
}

fn create_dir_mode(path: &Path) {
    create_dir(path).expect("create directory");
    chmod(path, 0o700);
}

pub(crate) fn create_file(path: &Path, bytes: &[u8]) {
    write(path, bytes).expect("write file");
    chmod(path, 0o600);
}

pub(crate) fn chmod(path: &Path, mode: u32) {
    let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions).expect("chmod");
}

fn open_read(path: &Path) -> OwnedFd {
    File::open(path).expect("open file").into()
}

fn open_dir(path: &Path) -> OwnedFd {
    open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .expect("open directory")
}

fn sorted_names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .into_string()
                .expect("utf8")
        })
        .collect();
    names.sort();
    names
}

fn replace_file_same_bytes(path: &Path) {
    let bytes = std::fs::read(path).expect("replacement bytes");
    let old = path.with_extension("retained-old");
    std::fs::rename(path, &old).expect("retain old file");
    create_file(path, &bytes);
    std::fs::remove_file(old).expect("remove old pathname");
}

fn replace_directory_same_bytes(path: &Path) {
    let old = path.with_extension("retained-old");
    std::fs::rename(path, &old).expect("retain old directory");
    create_dir_mode(path);
    for name in sorted_names(&old) {
        let bytes = std::fs::read(old.join(&name)).expect("replacement bytes");
        create_file(&path.join(name), &bytes);
    }
    for name in sorted_names(&old) {
        std::fs::remove_file(old.join(name)).expect("remove old file");
    }
    std::fs::remove_dir(old).expect("remove old pathname");
}
