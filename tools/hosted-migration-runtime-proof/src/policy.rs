use std::marker::PhantomData;

use crate::canonical::Digest32;

mod sealed {
    pub(crate) trait Sealed {}
}

pub(crate) trait EvidenceClass: sealed::Sealed + Sized + 'static {
    fn policy() -> ReleasePolicy;
    fn label() -> &'static str;
    fn source_schema() -> &'static str;
}

#[derive(Debug)]
pub(crate) enum OfficialEvidence {}

impl sealed::Sealed for OfficialEvidence {}

impl EvidenceClass for OfficialEvidence {
    fn policy() -> ReleasePolicy {
        ReleasePolicy {
            repository: "supabase/cli",
            release: "v2.116.0",
            checksums: AssetPolicy::new(
                "checksums.txt",
                1_414,
                "54f8d735be5b852a5f10afb116eeca46336f12aa4b398ee1fe26e5efd8ab35aa",
            ),
            archive: AssetPolicy::new(
                "supabase_2.116.0_linux_amd64.tar.gz",
                56_699_663,
                "5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158",
            ),
            entries: [
                EntryPolicy::new(
                    "supabase",
                    96_900_296,
                    "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4",
                    0o755,
                    ArchiveHeaderPolicy::new(
                        1_001,
                        1_001,
                        TarFormat::Gnu,
                        Some("bcfc0395fada1a7a6118aa194a046a83f8fd917833ff030a8cb705c98cbf8c7d"),
                    ),
                ),
                EntryPolicy::new(
                    "supabase-go",
                    43_892_898,
                    "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1",
                    0o755,
                    ArchiveHeaderPolicy::new(
                        1_001,
                        1_001,
                        TarFormat::Gnu,
                        Some("137ad9282585686605175d9e88927c551a90e7a07ca8bc48a93940ce48facaf7"),
                    ),
                ),
            ],
            manifest_line_limit: 64,
            uncompressed_limit: 140_800_000,
            owner: OwnerPolicy::Root,
        }
    }

    fn label() -> &'static str {
        "official"
    }

    fn source_schema() -> &'static str {
        "openspell.supabase-official-source.v1"
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(crate) enum SyntheticEvidence {}

#[cfg(test)]
impl sealed::Sealed for SyntheticEvidence {}

#[cfg(test)]
impl EvidenceClass for SyntheticEvidence {
    fn policy() -> ReleasePolicy {
        let archive = synthetic_archive_bytes();
        let archive_digest = crate::canonical::sha256(&archive);
        let checksum = synthetic_checksums_bytes(archive_digest);
        ReleasePolicy {
            repository: "synthetic/runtime-proof",
            release: "synthetic-v1",
            checksums: AssetPolicy {
                name: "checksums.txt",
                size: checksum.len() as u64,
                digest: crate::canonical::sha256(&checksum),
            },
            archive: AssetPolicy {
                name: "synthetic-runtime.tar.gz",
                size: archive.len() as u64,
                digest: archive_digest,
            },
            entries: [
                EntryPolicy {
                    name: "front-controller",
                    size: SYNTHETIC_FRONT.len() as u64,
                    digest: crate::canonical::sha256(SYNTHETIC_FRONT),
                    mode: 0o755,
                    archive_header: ArchiveHeaderPolicy {
                        uid: 0,
                        gid: 0,
                        format: TarFormat::Posix,
                        digest: None,
                    },
                },
                EntryPolicy {
                    name: "static-delegate",
                    size: SYNTHETIC_DELEGATE.len() as u64,
                    digest: crate::canonical::sha256(SYNTHETIC_DELEGATE),
                    mode: 0o755,
                    archive_header: ArchiveHeaderPolicy {
                        uid: 0,
                        gid: 0,
                        format: TarFormat::Posix,
                        digest: None,
                    },
                },
            ],
            manifest_line_limit: 1,
            uncompressed_limit: 4_096,
            owner: OwnerPolicy::RootDescriptor,
        }
    }

    fn label() -> &'static str {
        "synthetic"
    }

    fn source_schema() -> &'static str {
        "openspell.synthetic-source.v1"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AssetPolicy {
    pub(crate) name: &'static str,
    pub(crate) size: u64,
    pub(crate) digest: Digest32,
}

impl AssetPolicy {
    fn new(name: &'static str, size: u64, digest: &'static str) -> Self {
        Self {
            name,
            size,
            digest: Digest32::parse_hex(digest).expect("compiled digest is valid"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EntryPolicy {
    pub(crate) name: &'static str,
    pub(crate) size: u64,
    pub(crate) digest: Digest32,
    pub(crate) mode: u32,
    pub(crate) archive_header: ArchiveHeaderPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArchiveHeaderPolicy {
    pub(crate) uid: u64,
    pub(crate) gid: u64,
    pub(crate) format: TarFormat,
    pub(crate) digest: Option<Digest32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TarFormat {
    Posix,
    Gnu,
}

impl EntryPolicy {
    fn new(
        name: &'static str,
        size: u64,
        digest: &'static str,
        mode: u32,
        archive_header: ArchiveHeaderPolicy,
    ) -> Self {
        Self {
            name,
            size,
            digest: Digest32::parse_hex(digest).expect("compiled digest is valid"),
            mode,
            archive_header,
        }
    }
}

impl ArchiveHeaderPolicy {
    fn new(uid: u64, gid: u64, format: TarFormat, digest: Option<&'static str>) -> Self {
        Self {
            uid,
            gid,
            format,
            digest: digest.map(|digest| {
                Digest32::parse_hex(digest).expect("compiled header digest is valid")
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnerPolicy {
    Root,
    #[cfg(test)]
    RootDescriptor,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReleasePolicy {
    pub(crate) repository: &'static str,
    pub(crate) release: &'static str,
    pub(crate) checksums: AssetPolicy,
    pub(crate) archive: AssetPolicy,
    pub(crate) entries: [EntryPolicy; 2],
    pub(crate) manifest_line_limit: usize,
    pub(crate) uncompressed_limit: u64,
    pub(crate) owner: OwnerPolicy,
}

#[derive(Debug)]
pub(crate) struct EvidenceMarker<C: EvidenceClass>(PhantomData<fn() -> C>);

impl<C: EvidenceClass> EvidenceMarker<C> {
    pub(crate) fn new() -> Self {
        Self(PhantomData)
    }
}

#[cfg(test)]
pub(crate) const SYNTHETIC_FRONT: &[u8] = b"synthetic front controller\n";
#[cfg(test)]
pub(crate) const SYNTHETIC_DELEGATE: &[u8] = b"synthetic static delegate\n";

#[cfg(test)]
pub(crate) fn synthetic_checksums_bytes(archive_digest: Digest32) -> Vec<u8> {
    format!("{}  synthetic-runtime.tar.gz\n", archive_digest.to_hex()).into_bytes()
}

#[cfg(test)]
pub(crate) fn synthetic_archive_bytes() -> Vec<u8> {
    use std::io::Write as _;

    use flate2::{Compression, GzBuilder};

    fn octal(field: &mut [u8], value: u64) {
        field.fill(b'0');
        let digits = format!("{value:o}");
        let start = field.len() - 1 - digits.len();
        field[start..start + digits.len()].copy_from_slice(digits.as_bytes());
        field[field.len() - 1] = 0;
    }

    fn append(tar: &mut Vec<u8>, name: &str, body: &[u8]) {
        let mut header = [0_u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        octal(&mut header[100..108], 0o755);
        octal(&mut header[108..116], 0);
        octal(&mut header[116..124], 0);
        octal(&mut header[124..136], body.len() as u64);
        octal(&mut header[136..148], 0);
        header[148..156].fill(b' ');
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        let checksum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
        let digits = format!("{checksum:06o}");
        header[148..154].copy_from_slice(digits.as_bytes());
        header[154] = 0;
        header[155] = b' ';
        tar.extend_from_slice(&header);
        tar.extend_from_slice(body);
        tar.resize(tar.len().next_multiple_of(512), 0);
    }

    let mut tar = Vec::new();
    append(&mut tar, "front-controller", SYNTHETIC_FRONT);
    append(&mut tar, "static-delegate", SYNTHETIC_DELEGATE);
    tar.extend_from_slice(&[0_u8; 1_024]);

    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::best());
    encoder.write_all(&tar).expect("write synthetic gzip");
    encoder.finish().expect("finish synthetic gzip")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_policy_is_the_exact_reviewed_release() {
        let policy = OfficialEvidence::policy();
        assert_eq!(policy.repository, "supabase/cli");
        assert_eq!(policy.release, "v2.116.0");
        assert_eq!(policy.checksums.name, "checksums.txt");
        assert_eq!(policy.checksums.size, 1_414);
        assert_eq!(
            policy.checksums.digest.to_hex(),
            "54f8d735be5b852a5f10afb116eeca46336f12aa4b398ee1fe26e5efd8ab35aa"
        );
        assert_eq!(policy.archive.name, "supabase_2.116.0_linux_amd64.tar.gz");
        assert_eq!(policy.archive.size, 56_699_663);
        assert_eq!(
            policy.archive.digest.to_hex(),
            "5b3031cb297d51b25be4c284e4c852254460ec722ec221d3b81b07d55acfd158"
        );
        assert_eq!(policy.entries[0].name, "supabase");
        assert_eq!(policy.entries[0].size, 96_900_296);
        assert_eq!(
            policy.entries[0].digest.to_hex(),
            "3cfb10e8cb7b8cb4d6807117865a2a39891178ec83f4d0c86ac49f633d2c43f4"
        );
        assert_eq!(policy.entries[0].mode, 0o755);
        assert_eq!(policy.entries[0].archive_header.uid, 1_001);
        assert_eq!(policy.entries[0].archive_header.gid, 1_001);
        assert_eq!(policy.entries[0].archive_header.format, TarFormat::Gnu);
        assert_eq!(
            policy.entries[0]
                .archive_header
                .digest
                .expect("official header digest")
                .to_hex(),
            "bcfc0395fada1a7a6118aa194a046a83f8fd917833ff030a8cb705c98cbf8c7d"
        );
        assert_eq!(policy.entries[1].name, "supabase-go");
        assert_eq!(policy.entries[1].size, 43_892_898);
        assert_eq!(
            policy.entries[1].digest.to_hex(),
            "1530ee645cea869f6a440782b1732ede4b57d7646fea8494b8db1c59370e5eb1"
        );
        assert_eq!(policy.entries[1].mode, 0o755);
        assert_eq!(policy.entries[1].archive_header.uid, 1_001);
        assert_eq!(policy.entries[1].archive_header.gid, 1_001);
        assert_eq!(policy.entries[1].archive_header.format, TarFormat::Gnu);
        assert_eq!(
            policy.entries[1]
                .archive_header
                .digest
                .expect("official header digest")
                .to_hex(),
            "137ad9282585686605175d9e88927c551a90e7a07ca8bc48a93940ce48facaf7"
        );
        assert_eq!(policy.manifest_line_limit, 64);
        assert_eq!(policy.uncompressed_limit, 140_800_000);
        assert_eq!(policy.owner, OwnerPolicy::Root);
    }

    #[test]
    fn synthetic_policy_is_derived_only_from_its_fixed_recipe() {
        let policy = SyntheticEvidence::policy();
        let archive = synthetic_archive_bytes();
        assert_eq!(policy.archive.digest, crate::canonical::sha256(&archive));
        assert_eq!(policy.archive.size, archive.len() as u64);
        assert_ne!(policy.repository, OfficialEvidence::policy().repository);
    }
}
