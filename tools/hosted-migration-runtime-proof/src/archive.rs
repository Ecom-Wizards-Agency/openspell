use std::io::{Cursor, Read as _};

use flate2::bufread::GzDecoder;

use crate::canonical::{Digest32, sha256};
use crate::policy::{EntryPolicy, ReleasePolicy, TarFormat};

const TAR_BLOCK: usize = 512;
const TAR_END_BLOCKS: usize = 2;
const MANIFEST_LINE_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArchiveRefusal {
    ChecksumsAsset,
    ChecksumsSyntax,
    ChecksumsEntry,
    ArchiveAsset,
    Gzip,
    GzipTrailing,
    DecompressionLimit,
    TarStructure,
    TarHeader,
    TarPath,
    TarType,
    TarEntry,
    TarSize,
    TarDigest,
    TarTrailing,
    Conservation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedEntry {
    pub(crate) name: &'static str,
    pub(crate) mode: u32,
    pub(crate) bytes: Vec<u8>,
    pub(crate) digest: Digest32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedArchive {
    pub(crate) entries: [ParsedEntry; 2],
    pub(crate) compressed_bytes: u64,
    pub(crate) uncompressed_bytes: u64,
    pub(crate) payload_bytes: u64,
}

pub(crate) fn verify_assets(
    checksums: &[u8],
    archive: &[u8],
    policy: &ReleasePolicy,
) -> Result<ParsedArchive, ArchiveRefusal> {
    verify_asset(checksums, policy.checksums.size, policy.checksums.digest)
        .map_err(|_| ArchiveRefusal::ChecksumsAsset)?;
    verify_manifest(checksums, policy)?;
    verify_asset(archive, policy.archive.size, policy.archive.digest)
        .map_err(|_| ArchiveRefusal::ArchiveAsset)?;

    let tar = decode_one_gzip(archive, policy.uncompressed_limit)?;
    parse_exact_tar(&tar, archive.len() as u64, policy)
}

fn verify_asset(bytes: &[u8], size: u64, digest: Digest32) -> Result<(), ()> {
    if bytes.len() as u64 != size || sha256(bytes) != digest {
        return Err(());
    }
    Ok(())
}

fn verify_manifest(bytes: &[u8], policy: &ReleasePolicy) -> Result<(), ArchiveRefusal> {
    if bytes.is_empty() || !bytes.ends_with(b"\n") || bytes.contains(&b'\r') {
        return Err(ArchiveRefusal::ChecksumsSyntax);
    }

    let mut target_count = 0_usize;
    let mut line_count = 0_usize;
    for raw in bytes[..bytes.len() - 1].split(|byte| *byte == b'\n') {
        line_count = line_count
            .checked_add(1)
            .ok_or(ArchiveRefusal::ChecksumsSyntax)?;
        if line_count > policy.manifest_line_limit
            || raw.is_empty()
            || raw.len() > MANIFEST_LINE_BYTES
        {
            return Err(ArchiveRefusal::ChecksumsSyntax);
        }
        let line = std::str::from_utf8(raw).map_err(|_| ArchiveRefusal::ChecksumsSyntax)?;
        let (digest, name) = line
            .split_once("  ")
            .ok_or(ArchiveRefusal::ChecksumsSyntax)?;
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name == "."
            || name == ".."
            || name.chars().any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '-')
            })
        {
            return Err(ArchiveRefusal::ChecksumsSyntax);
        }
        let parsed = Digest32::parse_hex(digest).map_err(|_| ArchiveRefusal::ChecksumsSyntax)?;
        if name == policy.archive.name {
            target_count += 1;
            if parsed != policy.archive.digest {
                return Err(ArchiveRefusal::ChecksumsEntry);
            }
        }
    }
    if target_count != 1 {
        return Err(ArchiveRefusal::ChecksumsEntry);
    }
    Ok(())
}

fn decode_one_gzip(bytes: &[u8], limit: u64) -> Result<Vec<u8>, ArchiveRefusal> {
    let cursor = Cursor::new(bytes);
    let mut decoder = GzDecoder::new(cursor);
    let mut decoded = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = decoder
            .read(&mut buffer)
            .map_err(|_| ArchiveRefusal::Gzip)?;
        if read == 0 {
            break;
        }
        let next = decoded
            .len()
            .checked_add(read)
            .ok_or(ArchiveRefusal::DecompressionLimit)?;
        if next as u64 > limit {
            return Err(ArchiveRefusal::DecompressionLimit);
        }
        decoded.extend_from_slice(&buffer[..read]);
    }
    if decoder.get_ref().position() != bytes.len() as u64 {
        return Err(ArchiveRefusal::GzipTrailing);
    }
    Ok(decoded)
}

fn parse_exact_tar(
    tar: &[u8],
    compressed_bytes: u64,
    policy: &ReleasePolicy,
) -> Result<ParsedArchive, ArchiveRefusal> {
    if !tar.len().is_multiple_of(TAR_BLOCK) {
        return Err(ArchiveRefusal::TarStructure);
    }
    let mut offset = 0_usize;
    let mut parsed = Vec::with_capacity(policy.entries.len());
    loop {
        let header_end = offset
            .checked_add(TAR_BLOCK)
            .ok_or(ArchiveRefusal::TarStructure)?;
        let header = tar
            .get(offset..header_end)
            .ok_or(ArchiveRefusal::TarStructure)?;
        if header.iter().all(|byte| *byte == 0) {
            let required_end = offset
                .checked_add(TAR_BLOCK * TAR_END_BLOCKS)
                .ok_or(ArchiveRefusal::TarStructure)?;
            let trailer = tar
                .get(offset..required_end)
                .ok_or(ArchiveRefusal::TarTrailing)?;
            if !trailer.iter().all(|byte| *byte == 0)
                || !tar[required_end..].iter().all(|byte| *byte == 0)
            {
                return Err(ArchiveRefusal::TarTrailing);
            }
            break;
        }
        let expected = policy
            .entries
            .get(parsed.len())
            .ok_or(ArchiveRefusal::TarEntry)?;
        let entry = parse_header_and_body(header, &tar[header_end..], expected)?;
        let body_padded = round_up(entry.bytes.len(), TAR_BLOCK)?;
        let body_end = header_end
            .checked_add(entry.bytes.len())
            .ok_or(ArchiveRefusal::TarStructure)?;
        let padded_end = header_end
            .checked_add(body_padded)
            .ok_or(ArchiveRefusal::TarStructure)?;
        if tar
            .get(body_end..padded_end)
            .ok_or(ArchiveRefusal::TarStructure)?
            .iter()
            .any(|byte| *byte != 0)
        {
            return Err(ArchiveRefusal::TarTrailing);
        }
        offset = padded_end;
        parsed.push(entry);
    }

    let entries: [ParsedEntry; 2] = parsed.try_into().map_err(|_| ArchiveRefusal::TarEntry)?;
    let payload_bytes = entries.iter().try_fold(0_u64, |sum, entry| {
        sum.checked_add(entry.bytes.len() as u64)
            .ok_or(ArchiveRefusal::Conservation)
    })?;
    let expected_payload = policy.entries.iter().try_fold(0_u64, |sum, entry| {
        sum.checked_add(entry.size)
            .ok_or(ArchiveRefusal::Conservation)
    })?;
    if payload_bytes != expected_payload {
        return Err(ArchiveRefusal::Conservation);
    }
    Ok(ParsedArchive {
        entries,
        compressed_bytes,
        uncompressed_bytes: tar.len() as u64,
        payload_bytes,
    })
}

fn parse_header_and_body(
    header: &[u8],
    following: &[u8],
    expected: &EntryPolicy,
) -> Result<ParsedEntry, ArchiveRefusal> {
    verify_header_checksum(header)?;
    if expected
        .archive_header
        .digest
        .is_some_and(|expected_digest| sha256(header) != expected_digest)
    {
        return Err(ArchiveRefusal::TarHeader);
    }
    let archive_format = (&header[257..263], &header[263..265]);
    let format_matches = match expected.archive_header.format {
        TarFormat::Posix => archive_format == (b"ustar\0", b"00"),
        TarFormat::Gnu => archive_format == (b"ustar ", &[b' ', 0]),
    };
    if !format_matches || header[345..].iter().any(|byte| *byte != 0) {
        return Err(ArchiveRefusal::TarHeader);
    }
    if !matches!(header[156], 0 | b'0') {
        return Err(ArchiveRefusal::TarType);
    }
    if header[157..257].iter().any(|byte| *byte != 0) {
        return Err(ArchiveRefusal::TarType);
    }
    let name = parse_name(&header[..100])?;
    if name != expected.name {
        return Err(ArchiveRefusal::TarEntry);
    }
    let mode = parse_octal(&header[100..108])? as u32;
    let uid = parse_octal(&header[108..116])?;
    let gid = parse_octal(&header[116..124])?;
    let size = parse_octal(&header[124..136])?;
    if mode != expected.mode
        || uid != expected.archive_header.uid
        || gid != expected.archive_header.gid
    {
        return Err(ArchiveRefusal::TarHeader);
    }
    if size != expected.size {
        return Err(ArchiveRefusal::TarSize);
    }
    let body = following
        .get(..usize::try_from(size).map_err(|_| ArchiveRefusal::TarSize)?)
        .ok_or(ArchiveRefusal::TarSize)?;
    let digest = sha256(body);
    if digest != expected.digest {
        return Err(ArchiveRefusal::TarDigest);
    }
    Ok(ParsedEntry {
        name: expected.name,
        mode,
        bytes: body.to_vec(),
        digest,
    })
}

fn verify_header_checksum(header: &[u8]) -> Result<(), ArchiveRefusal> {
    let stored = parse_octal(&header[148..156])?;
    let actual = header
        .iter()
        .enumerate()
        .try_fold(0_u64, |sum, (index, byte)| {
            sum.checked_add(if (148..156).contains(&index) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            })
            .ok_or(ArchiveRefusal::TarHeader)
        })?;
    if stored != actual {
        return Err(ArchiveRefusal::TarHeader);
    }
    Ok(())
}

fn parse_name(field: &[u8]) -> Result<&str, ArchiveRefusal> {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .ok_or(ArchiveRefusal::TarPath)?;
    if end == 0 || field[end..].iter().any(|byte| *byte != 0) {
        return Err(ArchiveRefusal::TarPath);
    }
    let name = std::str::from_utf8(&field[..end]).map_err(|_| ArchiveRefusal::TarPath)?;
    if name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '-')
        })
    {
        return Err(ArchiveRefusal::TarPath);
    }
    Ok(name)
}

fn parse_octal(field: &[u8]) -> Result<u64, ArchiveRefusal> {
    if field.is_empty() || field[0] & 0x80 != 0 {
        return Err(ArchiveRefusal::TarHeader);
    }
    let mut value = 0_u64;
    let mut digit_seen = false;
    let mut ended = false;
    for byte in field {
        match *byte {
            b'0'..=b'7' if !ended => {
                digit_seen = true;
                value = value
                    .checked_mul(8)
                    .and_then(|value| value.checked_add(u64::from(*byte - b'0')))
                    .ok_or(ArchiveRefusal::TarHeader)?;
            }
            0 | b' ' => ended = digit_seen,
            _ => return Err(ArchiveRefusal::TarHeader),
        }
    }
    digit_seen.then_some(value).ok_or(ArchiveRefusal::TarHeader)
}

fn round_up(value: usize, block: usize) -> Result<usize, ArchiveRefusal> {
    value
        .checked_add(block - 1)
        .map(|value| value / block * block)
        .ok_or(ArchiveRefusal::TarStructure)
}

#[cfg(test)]
pub(crate) fn decode_one_gzip_for_test(
    bytes: &[u8],
    limit: u64,
) -> Result<Vec<u8>, ArchiveRefusal> {
    decode_one_gzip(bytes, limit)
}

#[cfg(test)]
pub(crate) fn verify_manifest_for_test(
    bytes: &[u8],
    policy: &ReleasePolicy,
) -> Result<(), ArchiveRefusal> {
    verify_manifest(bytes, policy)
}

#[cfg(test)]
pub(crate) fn parse_exact_tar_for_test(
    tar: &[u8],
    policy: &ReleasePolicy,
) -> Result<ParsedArchive, ArchiveRefusal> {
    parse_exact_tar(tar, 0, policy)
}
