use std::fs::{self, File};
use std::io::{Read as _, Seek as _, SeekFrom};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::archive::{
    ArchiveRefusal, decode_one_gzip_for_test, parse_exact_tar_for_test, verify_assets,
    verify_manifest_for_test,
};
use crate::elf::{
    ElfRefusal, Linkage, parse_component_for_test, synthetic_elf, verify_synthetic_runtime,
};
use crate::policy::{
    EvidenceClass, SYNTHETIC_DELEGATE, SYNTHETIC_FRONT, SyntheticEvidence, synthetic_archive_bytes,
    synthetic_checksums_bytes,
};
use crate::provenance::{
    FreshRetainedRoot, ProvenanceRefusal, RootAnchoredPair, TestFaultPoint,
    filesystem_root_is_self_parent_for_test, seal_release, set_test_fault,
};

struct Lab {
    _temporary: TempDir,
    root: PathBuf,
    intake: PathBuf,
    destination: PathBuf,
}

impl Lab {
    fn new() -> Self {
        let temporary = tempfile::tempdir().expect("temporary laboratory");
        let root = temporary.path().to_path_buf();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        let intake = root.join("intake");
        let destination = root.join("retained");
        fs::create_dir(&intake).expect("intake");
        fs::create_dir(&destination).expect("destination");
        fs::set_permissions(&intake, fs::Permissions::from_mode(0o700)).expect("intake mode");
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o700))
            .expect("destination mode");
        let archive = synthetic_archive_bytes();
        let checksums = synthetic_checksums_bytes(crate::canonical::sha256(&archive));
        fs::write(intake.join("checksums.txt"), checksums).expect("checksums");
        fs::write(intake.join("synthetic-runtime.tar.gz"), archive).expect("archive");
        fs::set_permissions(
            intake.join("checksums.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .expect("checksums mode");
        fs::set_permissions(
            intake.join("synthetic-runtime.tar.gz"),
            fs::Permissions::from_mode(0o600),
        )
        .expect("archive mode");
        Self {
            _temporary: temporary,
            root,
            intake,
            destination,
        }
    }

    fn pair(&self) -> Result<RootAnchoredPair<SyntheticEvidence>, ProvenanceRefusal> {
        RootAnchoredPair::from_open_descriptors(
            File::open(&self.root).expect("root descriptor"),
            vec![File::open(&self.intake).expect("ancestor descriptor")],
            File::open(&self.intake).expect("intake descriptor"),
            File::open(self.intake.join("checksums.txt")).expect("checksums descriptor"),
            File::open(self.intake.join("synthetic-runtime.tar.gz")).expect("archive descriptor"),
        )
    }

    fn destination(&self) -> FreshRetainedRoot {
        FreshRetainedRoot::from_open_descriptor(
            File::open(&self.destination).expect("destination descriptor"),
        )
        .expect("fresh destination")
    }
}

#[test]
fn official_root_anchor_requires_the_actual_filesystem_root() {
    let filesystem_root = File::open("/").expect("filesystem root descriptor");
    assert!(filesystem_root_is_self_parent_for_test(&filesystem_root));

    let lab = Lab::new();
    let pseudo_root = File::open(&lab.root).expect("pseudo root descriptor");
    assert!(!filesystem_root_is_self_parent_for_test(&pseudo_root));
}

#[test]
fn intake_inventory_refuses_extra_files_directories_and_post_admission_drift() {
    let extra_file = Lab::new();
    fs::write(extra_file.intake.join("extra"), b"unexpected").expect("extra file");
    assert_eq!(
        extra_file.pair().err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );

    let extra_directory = Lab::new();
    fs::create_dir(extra_directory.intake.join("extra")).expect("extra directory");
    assert_eq!(
        extra_directory.pair().err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );

    let drift = Lab::new();
    let pair = drift.pair().expect("admitted pair");
    fs::write(drift.intake.join("late-extra"), b"unexpected").expect("late extra file");
    assert_eq!(
        seal_release(pair, drift.destination()).err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );
    assert!(
        FreshRetainedRoot::from_open_descriptor(
            File::open(&drift.destination).expect("consumed destination")
        )
        .is_err()
    );
}

#[test]
fn exact_two_entry_release_is_retained_and_reopened_with_conservation() {
    let lab = Lab::new();
    let retained = seal_release(lab.pair().expect("anchored pair"), lab.destination())
        .expect("sealed release");
    let counts = retained.conservation();
    assert_eq!(
        (
            counts.offered_count,
            counts.parsed_count,
            counts.published_count,
            counts.reopened_count,
        ),
        (2, 2, 2, 2)
    );
    let expected_bytes = (SYNTHETIC_FRONT.len() + SYNTHETIC_DELEGATE.len()) as u64;
    assert_eq!(
        (
            counts.offered_bytes,
            counts.parsed_bytes,
            counts.published_bytes,
            counts.reopened_bytes,
        ),
        (
            expected_bytes,
            expected_bytes,
            expected_bytes,
            expected_bytes
        )
    );
    assert_eq!(counts.parsed_digests, counts.published_digests);
    assert_eq!(counts.published_digests, counts.reopened_digests);
    for file in retained.retained() {
        let metadata = file.metadata().expect("retained metadata");
        assert_eq!(metadata.mode() & 0o777, 0o555);
        assert_eq!(metadata.nlink(), 1);
    }
    let mut inventory = retained.inventory().try_clone().expect("inventory clone");
    inventory.seek(SeekFrom::Start(0)).expect("inventory seek");
    let mut inventory_bytes = String::new();
    inventory
        .read_to_string(&mut inventory_bytes)
        .expect("inventory read");
    assert!(inventory_bytes.contains("\"evidence_class\": \"synthetic\""));
    assert!(!inventory_bytes.contains(lab.root.to_str().expect("utf8 path")));

    let source_evidence =
        std::str::from_utf8(retained.source_evidence_bytes()).expect("canonical source evidence");
    let ordered_fields = [
        "schemaVersion",
        "repository",
        "releaseTag",
        "checksumsAssetName",
        "checksumsAssetBytes",
        "checksumsAssetSha256",
        "archiveAssetName",
        "archiveBytes",
        "archiveSha256",
        "archiveEntries",
        "frontControllerEntry",
        "frontControllerBytes",
        "frontControllerSha256",
        "delegateEntry",
        "delegateBytes",
        "delegateSha256",
        "sourceRootDevice",
        "sourceRootInode",
        "sourceRootMode",
        "sourceRootUid",
        "sourceRootGid",
        "ancestorWalkSha256",
        "acquiredAt",
    ];
    let mut previous = 0;
    for field in ordered_fields {
        let current = source_evidence
            .find(&format!("\"{field}\""))
            .expect("required source-evidence field");
        assert!(current >= previous, "field order drifted at {field}");
        previous = current;
    }
    assert!(source_evidence.contains("openspell.synthetic-source.v1"));
    assert_eq!(
        retained.source_evidence_digest(),
        crate::canonical::sha256(retained.source_evidence_bytes())
    );
}

#[test]
fn retained_release_revalidation_refuses_mode_link_and_inventory_drift() {
    let mode_lab = Lab::new();
    let mode_release = seal_release(mode_lab.pair().expect("mode pair"), mode_lab.destination())
        .expect("mode release");
    fs::set_permissions(
        mode_lab.destination.join("front-controller"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("mode drift");
    assert!(mode_release.revalidate_for_runtime().is_err());

    let link_lab = Lab::new();
    let link_release = seal_release(link_lab.pair().expect("link pair"), link_lab.destination())
        .expect("link release");
    fs::hard_link(
        link_lab.destination.join("front-controller"),
        link_lab.destination.join("extra-link"),
    )
    .expect("link drift");
    assert!(link_release.revalidate_for_runtime().is_err());

    let root_lab = Lab::new();
    let root_release = seal_release(root_lab.pair().expect("root pair"), root_lab.destination())
        .expect("root release");
    fs::set_permissions(&root_lab.destination, fs::Permissions::from_mode(0o750))
        .expect("root drift");
    assert!(root_release.revalidate_for_runtime().is_err());
}

#[test]
fn an_early_source_failure_still_consumes_the_destination() {
    let lab = Lab::new();
    let pair = lab.pair().expect("admitted pair");
    fs::write(lab.intake.join("checksums.txt"), b"changed").expect("source drift");
    assert_eq!(
        seal_release(pair, lab.destination()).err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );
    assert!(
        FreshRetainedRoot::from_open_descriptor(
            File::open(&lab.destination).expect("consumed destination")
        )
        .is_err()
    );
}

#[test]
fn checksum_gzip_and_decompression_adversaries_fail_closed() {
    let policy = SyntheticEvidence::policy();
    let archive = synthetic_archive_bytes();
    let checksums = synthetic_checksums_bytes(crate::canonical::sha256(&archive));
    assert!(verify_assets(&checksums, &archive, &policy).is_ok());

    let mut no_newline = checksums.clone();
    no_newline.pop();
    assert_eq!(
        verify_manifest_for_test(&no_newline, &policy),
        Err(ArchiveRefusal::ChecksumsSyntax)
    );
    let duplicate = [checksums.as_slice(), checksums.as_slice()].concat();
    assert_eq!(
        verify_manifest_for_test(&duplicate, &policy),
        Err(ArchiveRefusal::ChecksumsSyntax)
    );
    let wrong = format!("{}  synthetic-runtime.tar.gz\n", "00".repeat(32));
    assert_eq!(
        verify_manifest_for_test(wrong.as_bytes(), &policy),
        Err(ArchiveRefusal::ChecksumsEntry)
    );

    let concatenated = [archive.as_slice(), archive.as_slice()].concat();
    assert_eq!(
        decode_one_gzip_for_test(&concatenated, policy.uncompressed_limit),
        Err(ArchiveRefusal::GzipTrailing)
    );
    let mut trailing = archive.clone();
    trailing.push(0);
    assert_eq!(
        decode_one_gzip_for_test(&trailing, policy.uncompressed_limit),
        Err(ArchiveRefusal::GzipTrailing)
    );
    assert_eq!(
        decode_one_gzip_for_test(&archive, 512),
        Err(ArchiveRefusal::DecompressionLimit)
    );
    let mut corrupt = archive;
    let corrupt_at = corrupt.len() / 2;
    corrupt[corrupt_at] ^= 1;
    assert_eq!(
        decode_one_gzip_for_test(&corrupt, policy.uncompressed_limit),
        Err(ArchiveRefusal::Gzip)
    );
}

#[test]
fn tar_path_type_size_digest_and_trailer_adversaries_fail_closed() {
    let policy = SyntheticEvidence::policy();
    let archive = synthetic_archive_bytes();
    let tar = decode_one_gzip_for_test(&archive, policy.uncompressed_limit).expect("tar");

    let mut path = tar.clone();
    path[..100].fill(0);
    path[..4].copy_from_slice(b"../x");
    refresh_tar_checksum(&mut path[..512]);
    assert_eq!(
        parse_exact_tar_for_test(&path, &policy),
        Err(ArchiveRefusal::TarPath)
    );

    let mut link = tar.clone();
    link[156] = b'2';
    refresh_tar_checksum(&mut link[..512]);
    assert_eq!(
        parse_exact_tar_for_test(&link, &policy),
        Err(ArchiveRefusal::TarType)
    );

    let mut wrong_size = tar.clone();
    write_octal(
        &mut wrong_size[124..136],
        (SYNTHETIC_FRONT.len() + 1) as u64,
    );
    refresh_tar_checksum(&mut wrong_size[..512]);
    assert_eq!(
        parse_exact_tar_for_test(&wrong_size, &policy),
        Err(ArchiveRefusal::TarSize)
    );

    let mut base_256 = tar.clone();
    base_256[124] = 0x80;
    refresh_tar_checksum(&mut base_256[..512]);
    assert_eq!(
        parse_exact_tar_for_test(&base_256, &policy),
        Err(ArchiveRefusal::TarHeader)
    );

    let mut wrong_format = tar.clone();
    wrong_format[257..263].copy_from_slice(b"ustar ");
    wrong_format[263] = b' ';
    wrong_format[264] = 0;
    refresh_tar_checksum(&mut wrong_format[..512]);
    assert_eq!(
        parse_exact_tar_for_test(&wrong_format, &policy),
        Err(ArchiveRefusal::TarHeader)
    );

    let mut body = tar.clone();
    body[512] ^= 1;
    assert_eq!(
        parse_exact_tar_for_test(&body, &policy),
        Err(ArchiveRefusal::TarDigest)
    );

    let mut hidden_padding = tar.clone();
    hidden_padding[512 + SYNTHETIC_FRONT.len()] = 1;
    assert_eq!(
        parse_exact_tar_for_test(&hidden_padding, &policy),
        Err(ArchiveRefusal::TarTrailing)
    );

    let mut trailing = tar.clone();
    trailing.extend_from_slice(&[0_u8; 512]);
    *trailing.last_mut().expect("last") = 1;
    assert_eq!(
        parse_exact_tar_for_test(&trailing, &policy),
        Err(ArchiveRefusal::TarTrailing)
    );

    assert_eq!(
        parse_exact_tar_for_test(&tar[..tar.len() - 512], &policy),
        Err(ArchiveRefusal::TarTrailing)
    );
}

#[test]
fn descriptor_replacement_link_mode_and_ancestor_substitution_are_refused() {
    let replacement = Lab::new();
    let pair = replacement.pair().expect("pair before replacement");
    fs::rename(
        replacement.intake.join("synthetic-runtime.tar.gz"),
        replacement.intake.join("displaced"),
    )
    .expect("displace archive");
    fs::write(
        replacement.intake.join("synthetic-runtime.tar.gz"),
        synthetic_archive_bytes(),
    )
    .expect("replace archive");
    assert_eq!(
        seal_release(pair, replacement.destination()).err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );

    let linked = Lab::new();
    fs::hard_link(
        linked.intake.join("checksums.txt"),
        linked.intake.join("second-link"),
    )
    .expect("hard link");
    assert_eq!(linked.pair().err(), Some(ProvenanceRefusal::SourceMismatch));

    let writable = Lab::new();
    fs::set_permissions(
        writable.intake.join("checksums.txt"),
        fs::Permissions::from_mode(0o664),
    )
    .expect("writable mode");
    assert_eq!(
        writable.pair().err(),
        Some(ProvenanceRefusal::SourceMismatch)
    );

    let wrong_ancestor = Lab::new();
    let result: Result<RootAnchoredPair<SyntheticEvidence>, _> =
        RootAnchoredPair::from_open_descriptors(
            File::open(&wrong_ancestor.root).expect("root"),
            vec![File::open(&wrong_ancestor.destination).expect("wrong ancestor")],
            File::open(&wrong_ancestor.intake).expect("intake"),
            File::open(wrong_ancestor.intake.join("checksums.txt")).expect("checksums"),
            File::open(wrong_ancestor.intake.join("synthetic-runtime.tar.gz")).expect("archive"),
        );
    assert_eq!(result.err(), Some(ProvenanceRefusal::SourceMismatch));
}

#[test]
fn every_publication_cut_consumes_the_nonempty_destination_without_a_result() {
    for point in [
        TestFaultPoint::DestinationConsumed,
        TestFaultPoint::EntrySynced(0),
        TestFaultPoint::EntrySynced(1),
        TestFaultPoint::EntriesDirectorySynced,
        TestFaultPoint::BeforeInventory,
        TestFaultPoint::InventorySynced,
        TestFaultPoint::InventoryDirectorySynced,
        TestFaultPoint::Reopened,
        TestFaultPoint::FinalDirectorySynced,
    ] {
        let lab = Lab::new();
        set_test_fault(Some(point));
        let result = seal_release(lab.pair().expect("pair"), lab.destination());
        set_test_fault(None);
        assert_eq!(result.err(), Some(ProvenanceRefusal::RetentionUncertain));
        assert!(
            FreshRetainedRoot::from_open_descriptor(
                File::open(&lab.destination).expect("failed destination")
            )
            .is_err(),
            "fault {point:?} left a reusable destination"
        );
    }
}

#[test]
fn elf_parser_rejects_format_architecture_linkage_mapping_and_dependency_substitution() {
    let dynamic = synthetic_elf(
        Linkage::DynamicExecutable,
        Some("runtime-loader"),
        &["libsynthetic.so"],
    );
    assert!(
        parse_component_for_test(
            &dynamic,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        )
        .is_ok()
    );
    let static_binary = synthetic_elf(Linkage::StaticExecutable, None, &[]);
    assert!(parse_component_for_test(&static_binary, Linkage::StaticExecutable, None, &[]).is_ok());
    let exact_absolute_interpreter = synthetic_elf(
        Linkage::DynamicExecutable,
        Some("/lib64/ld-linux-x86-64.so.2"),
        &[],
    );
    assert!(
        parse_component_for_test(
            &exact_absolute_interpreter,
            Linkage::DynamicExecutable,
            Some("/lib64/ld-linux-x86-64.so.2"),
            &[],
        )
        .is_ok()
    );

    let mut bad_magic = dynamic.clone();
    bad_magic[0] = 0;
    assert_eq!(
        parse_component_for_test(
            &bad_magic,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        Err(ElfRefusal::Format)
    );
    let mut wrong_arch = dynamic.clone();
    wrong_arch[18..20].copy_from_slice(&3_u16.to_le_bytes());
    assert_eq!(
        parse_component_for_test(
            &wrong_arch,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        Err(ElfRefusal::Architecture)
    );
    let mut writable_executable = dynamic.clone();
    let flags = u32::from_le_bytes(writable_executable[68..72].try_into().expect("flags"));
    writable_executable[68..72].copy_from_slice(&(flags | 2).to_le_bytes());
    assert_eq!(
        parse_component_for_test(
            &writable_executable,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        Err(ElfRefusal::ProgramHeaders)
    );
    let host_interpreter = synthetic_elf(
        Linkage::DynamicExecutable,
        Some("/host/loader"),
        &["libsynthetic.so"],
    );
    assert_eq!(
        parse_component_for_test(
            &host_interpreter,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        Err(ElfRefusal::Interpreter)
    );
    let substituted = synthetic_elf(
        Linkage::DynamicExecutable,
        Some("runtime-loader"),
        &["libsubstituted.so"],
    );
    assert_eq!(
        parse_component_for_test(
            &substituted,
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        Err(ElfRefusal::Dependency)
    );
}

#[test]
fn runtime_inventory_is_exact_descriptor_relative_and_nonwritable() {
    let temporary = tempfile::tempdir().expect("runtime root");
    write_runtime_inventory(temporary.path());
    let root = File::open(temporary.path()).expect("runtime root descriptor");
    let verified = verify_synthetic_runtime(&root).expect("verified runtime");
    assert_eq!(verified.front.linkage, Linkage::DynamicExecutable);
    assert_eq!(verified.delegate.linkage, Linkage::StaticExecutable);

    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700))
        .expect("open runtime root for mutation");
    fs::write(temporary.path().join("extra"), b"extra").expect("extra");
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o500))
        .expect("reseal runtime root");
    assert_eq!(
        verify_synthetic_runtime(&root).err(),
        Some(ElfRefusal::Inventory)
    );

    let writable = tempfile::tempdir().expect("writable runtime root");
    write_runtime_inventory(writable.path());
    fs::set_permissions(
        writable.path().join("front-controller"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("writable executable");
    assert_eq!(
        verify_synthetic_runtime(&File::open(writable.path()).expect("root")).err(),
        Some(ElfRefusal::WritableObject)
    );
}

#[test]
fn refusal_values_do_not_echo_private_inputs() {
    let canary = ["private", "target", "canary"].join("-");
    for refusal in [
        ProvenanceRefusal::SourceUnavailable,
        ProvenanceRefusal::SourceMismatch,
        ProvenanceRefusal::ArchiveRejected,
        ProvenanceRefusal::RetentionUncertain,
    ] {
        assert!(!format!("{refusal:?}").contains(&canary));
    }
}

fn write_runtime_inventory(root: &Path) {
    for (name, bytes) in [
        (
            "front-controller",
            synthetic_elf(
                Linkage::DynamicExecutable,
                Some("runtime-loader"),
                &["libsynthetic.so"],
            ),
        ),
        (
            "libsynthetic.so",
            synthetic_elf(Linkage::SharedObject, None, &[]),
        ),
        (
            "runtime-loader",
            synthetic_elf(Linkage::SharedObject, None, &[]),
        ),
        (
            "static-delegate",
            synthetic_elf(Linkage::StaticExecutable, None, &[]),
        ),
    ] {
        let path = root.join(name);
        fs::write(&path, bytes).expect("runtime object");
        fs::set_permissions(path, fs::Permissions::from_mode(0o555)).expect("immutable mode");
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o500)).expect("immutable runtime root");
}

fn write_octal(field: &mut [u8], value: u64) {
    field.fill(b'0');
    let digits = format!("{value:o}");
    let start = field.len() - digits.len() - 1;
    field[start..start + digits.len()].copy_from_slice(digits.as_bytes());
    field[field.len() - 1] = 0;
}

fn refresh_tar_checksum(header: &mut [u8]) {
    header[148..156].fill(b' ');
    let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let digits = format!("{checksum:06o}");
    header[148..154].copy_from_slice(digits.as_bytes());
    header[154] = 0;
    header[155] = b' ';
}
