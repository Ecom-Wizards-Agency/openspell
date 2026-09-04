use sha2::{Digest as _, Sha256};

use crate::authority_registry_tests::{InstallationFixture, chmod, create_file};
use crate::preparation_v2::{
    FORMAT_BYTES, FORMAT_SHA256, GENESIS_DOMAIN, GENESIS_SHA256, INVENTORY_DOMAIN,
    MAX_RECORD_BYTES, MAX_RECORDS, MAX_SIGNATURES, MAX_TOTAL_BYTES, MAX_TRANSITIONS,
};

#[test]
fn preparation_v2_namespace_domains_and_limits_are_exact() {
    assert_eq!(hex::encode(Sha256::digest(FORMAT_BYTES)), FORMAT_SHA256);
    assert_eq!(hex::encode(Sha256::digest(GENESIS_DOMAIN)), GENESIS_SHA256);
    assert_eq!(
        INVENTORY_DOMAIN,
        b"openspell.hosted-migration-preparation-inventory.v2\n"
    );
    assert_eq!(MAX_TRANSITIONS, 4_096);
    assert_eq!(MAX_RECORDS, 12_288);
    assert_eq!(MAX_SIGNATURES, 16_384);
    assert_eq!(MAX_RECORD_BYTES, 16_384);
    assert_eq!(MAX_TOTAL_BYTES, 64 * 1024 * 1024);
}

#[test]
fn preparation_v2_step_three_exposes_no_semantic_record_surface() {
    let source = include_str!("preparation_v2.rs");
    for forbidden in [
        "append_transition",
        "target_fingerprint",
        "closed_no_apply",
        "execution_ticket",
        "dry_run",
    ] {
        assert!(
            !source.contains(forbidden),
            "forbidden step-four surface: {forbidden}"
        );
    }
}

#[test]
fn empty_v2_recovery_refuses_permission_drift_and_unknown_transition() {
    let permissions = InstallationFixture::new("openspell-wp201-v2-permissions-");
    drop(permissions.install_fresh());
    chmod(
        &permissions.state_path.join("PREPARATION_JOURNAL_V2/FORMAT"),
        0o640,
    );
    assert!(permissions.recover().is_err());

    let transition = InstallationFixture::new("openspell-wp201-v2-transition-");
    drop(transition.install_fresh());
    create_file(
        &transition.state_path.join(concat!(
            "PREPARATION_JOURNAL_V2/transitions/00000000000000000001-",
            "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
            ".json"
        )),
        b"{}\n",
    );
    assert!(transition.recover().is_err());
}
