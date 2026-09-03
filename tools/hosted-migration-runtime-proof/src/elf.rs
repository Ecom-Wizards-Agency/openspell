use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::marker::PhantomData;

use goblin::elf::{Elf, header, program_header};
#[cfg(test)]
use rustix::fs::{AtFlags, Mode, OFlags, ResolveFlags, StatxFlags, openat2, statx};

use crate::canonical::{Digest32, sha256};
use crate::policy::{EvidenceMarker, OfficialEvidence};
use crate::provenance::RetainedRelease;

const MAX_PROGRAM_HEADERS: usize = 128;
const MAX_INTERPRETER_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ElfRefusal {
    Unavailable,
    Digest,
    Format,
    Architecture,
    ProgramHeaders,
    Interpreter,
    Linkage,
    Dependency,
    Inventory,
    WritableObject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Linkage {
    DynamicExecutable,
    StaticExecutable,
    SharedObject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ElfComponent {
    pub(crate) bytes: u64,
    pub(crate) digest: Digest32,
    pub(crate) linkage: Linkage,
    pub(crate) interpreter: Option<String>,
    pub(crate) needed: Vec<String>,
}

pub(crate) struct OfficialRuntimeComponents {
    pub(crate) front: ElfComponent,
    pub(crate) delegate: ElfComponent,
    incomplete: IncompleteOfficialRuntime,
    marker: EvidenceMarker<OfficialEvidence>,
}

#[derive(Clone, Copy)]
struct IncompleteOfficialRuntime(PhantomData<fn() -> OfficialEvidence>);

pub(crate) fn inspect_official_components(
    release: &RetainedRelease<OfficialEvidence>,
) -> Result<OfficialRuntimeComponents, ElfRefusal> {
    let policy = <OfficialEvidence as crate::policy::EvidenceClass>::policy();
    let front_bytes = read_bounded(&release.retained()[0], policy.entries[0].size)?;
    let delegate_bytes = read_bounded(&release.retained()[1], policy.entries[1].size)?;
    if sha256(&front_bytes) != policy.entries[0].digest
        || sha256(&delegate_bytes) != policy.entries[1].digest
    {
        return Err(ElfRefusal::Digest);
    }
    let front = parse_component(&front_bytes, ExpectedLinkage::Dynamic, None, None)?;
    let delegate = parse_component(&delegate_bytes, ExpectedLinkage::Static, None, None)?;
    Ok(OfficialRuntimeComponents {
        front,
        delegate,
        incomplete: IncompleteOfficialRuntime(PhantomData),
        marker: EvidenceMarker::new(),
    })
}

#[derive(Clone, Copy)]
enum ExpectedLinkage {
    Dynamic,
    Static,
    Shared,
}

fn parse_component(
    bytes: &[u8],
    expected: ExpectedLinkage,
    expected_interpreter: Option<&str>,
    expected_needed: Option<&[&str]>,
) -> Result<ElfComponent, ElfRefusal> {
    let elf = Elf::parse(bytes).map_err(|_| ElfRefusal::Format)?;
    if !elf.is_64
        || !elf.little_endian
        || elf.header.e_ident[header::EI_CLASS] != header::ELFCLASS64
        || elf.header.e_ident[header::EI_DATA] != header::ELFDATA2LSB
        || elf.header.e_ident[header::EI_VERSION] != header::EV_CURRENT
        || !matches!(
            elf.header.e_ident[header::EI_OSABI],
            header::ELFOSABI_SYSV | header::ELFOSABI_GNU
        )
        || elf.header.e_version != u32::from(header::EV_CURRENT)
    {
        return Err(ElfRefusal::Format);
    }
    if elf.header.e_machine != header::EM_X86_64 {
        return Err(ElfRefusal::Architecture);
    }
    if elf.header.e_ehsize != 64
        || elf.header.e_phentsize != 56
        || elf.program_headers.is_empty()
        || elf.program_headers.len() > MAX_PROGRAM_HEADERS
        || usize::from(elf.header.e_phnum) != elf.program_headers.len()
    {
        return Err(ElfRefusal::ProgramHeaders);
    }
    verify_program_headers(bytes, &elf)?;

    let interpreter = exact_interpreter(bytes, &elf)?;
    let needed = elf
        .libraries
        .iter()
        .map(|name| validate_leaf(name).map(str::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    let mut unique = needed.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != needed.len()
        || !elf.rpaths.is_empty()
        || !elf.runpaths.is_empty()
        || elf.soname.is_some() && !matches!(expected, ExpectedLinkage::Shared)
    {
        return Err(ElfRefusal::Dependency);
    }

    let linkage = match expected {
        ExpectedLinkage::Dynamic => {
            if !matches!(elf.header.e_type, header::ET_EXEC | header::ET_DYN)
                || elf.entry == 0
                || elf.dynamic.is_none()
                || interpreter.is_none()
            {
                return Err(ElfRefusal::Linkage);
            }
            if let Some(expected_interpreter) = expected_interpreter {
                let actual = interpreter.as_deref().ok_or(ElfRefusal::Interpreter)?;
                validate_leaf(actual)?;
                if actual != expected_interpreter {
                    return Err(ElfRefusal::Interpreter);
                }
            }
            Linkage::DynamicExecutable
        }
        ExpectedLinkage::Static => {
            if elf.header.e_type != header::ET_EXEC
                || elf.entry == 0
                || elf.dynamic.is_some()
                || interpreter.is_some()
                || !needed.is_empty()
            {
                return Err(ElfRefusal::Linkage);
            }
            Linkage::StaticExecutable
        }
        ExpectedLinkage::Shared => {
            if elf.header.e_type != header::ET_DYN || interpreter.is_some() {
                return Err(ElfRefusal::Linkage);
            }
            Linkage::SharedObject
        }
    };
    if let Some(expected) = expected_needed
        && needed.iter().map(String::as_str).collect::<Vec<_>>() != expected
    {
        return Err(ElfRefusal::Dependency);
    }
    Ok(ElfComponent {
        bytes: bytes.len() as u64,
        digest: sha256(bytes),
        linkage,
        interpreter,
        needed,
    })
}

fn verify_program_headers(bytes: &[u8], elf: &Elf<'_>) -> Result<(), ElfRefusal> {
    let mut load_count = 0_usize;
    for program in &elf.program_headers {
        let end = program
            .p_offset
            .checked_add(program.p_filesz)
            .ok_or(ElfRefusal::ProgramHeaders)?;
        if end > bytes.len() as u64
            || program.p_memsz < program.p_filesz
            || program.p_align != 0 && !program.p_align.is_power_of_two()
        {
            return Err(ElfRefusal::ProgramHeaders);
        }
        if program.p_type == program_header::PT_LOAD {
            load_count += 1;
            if program.p_flags & program_header::PF_W != 0
                && program.p_flags & program_header::PF_X != 0
            {
                return Err(ElfRefusal::ProgramHeaders);
            }
        }
    }
    if load_count == 0 {
        return Err(ElfRefusal::ProgramHeaders);
    }
    Ok(())
}

fn exact_interpreter(bytes: &[u8], elf: &Elf<'_>) -> Result<Option<String>, ElfRefusal> {
    let headers = elf
        .program_headers
        .iter()
        .filter(|program| program.p_type == program_header::PT_INTERP)
        .collect::<Vec<_>>();
    if headers.len() > 1 {
        return Err(ElfRefusal::Interpreter);
    }
    let Some(program) = headers.first() else {
        return Ok(None);
    };
    let size = usize::try_from(program.p_filesz).map_err(|_| ElfRefusal::Interpreter)?;
    if !(2..=MAX_INTERPRETER_BYTES).contains(&size) {
        return Err(ElfRefusal::Interpreter);
    }
    let start = usize::try_from(program.p_offset).map_err(|_| ElfRefusal::Interpreter)?;
    let field = bytes
        .get(start..start + size)
        .ok_or(ElfRefusal::Interpreter)?;
    if field.last() != Some(&0) || field[..field.len() - 1].contains(&0) {
        return Err(ElfRefusal::Interpreter);
    }
    let name =
        std::str::from_utf8(&field[..field.len() - 1]).map_err(|_| ElfRefusal::Interpreter)?;
    if name.chars().any(|character| character.is_control())
        || name.split('/').any(|component| component == "..")
    {
        return Err(ElfRefusal::Interpreter);
    }
    Ok(Some(name.to_owned()))
}

fn validate_leaf(name: &str) -> Result<&str, ElfRefusal> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| {
            !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | '-')
        })
    {
        return Err(ElfRefusal::Dependency);
    }
    Ok(name)
}

fn read_bounded(file: &File, exact_size: u64) -> Result<Vec<u8>, ElfRefusal> {
    let mut reader = file.try_clone().map_err(|_| ElfRefusal::Unavailable)?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| ElfRefusal::Unavailable)?;
    let mut bytes =
        Vec::with_capacity(usize::try_from(exact_size).map_err(|_| ElfRefusal::Unavailable)?);
    reader
        .take(exact_size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ElfRefusal::Unavailable)?;
    if bytes.len() as u64 != exact_size {
        return Err(ElfRefusal::Digest);
    }
    Ok(bytes)
}

#[cfg(test)]
pub(crate) struct SyntheticRuntimeComponents {
    pub(crate) front: ElfComponent,
    pub(crate) delegate: ElfComponent,
    pub(crate) loader: ElfComponent,
    pub(crate) dependency: ElfComponent,
    marker: EvidenceMarker<crate::policy::SyntheticEvidence>,
}

#[cfg(test)]
pub(crate) fn verify_synthetic_runtime(
    root: &File,
) -> Result<SyntheticRuntimeComponents, ElfRefusal> {
    const NAMES: [&str; 4] = [
        "front-controller",
        "libsynthetic.so",
        "runtime-loader",
        "static-delegate",
    ];
    let expected_objects = [
        synthetic_elf(
            Linkage::DynamicExecutable,
            Some("runtime-loader"),
            &["libsynthetic.so"],
        ),
        synthetic_elf(Linkage::SharedObject, None, &[]),
        synthetic_elf(Linkage::SharedObject, None, &[]),
        synthetic_elf(Linkage::StaticExecutable, None, &[]),
    ];
    let root_stat = statx(
        root,
        c"",
        AtFlags::EMPTY_PATH,
        StatxFlags::BASIC_STATS | StatxFlags::MNT_ID,
    )
    .map_err(|_| ElfRefusal::Inventory)?;
    if root_stat.stx_mask & (StatxFlags::BASIC_STATS | StatxFlags::MNT_ID).bits()
        != (StatxFlags::BASIC_STATS | StatxFlags::MNT_ID).bits()
        || root_stat.stx_mode & 0o170_000 != 0o040_000
        || root_stat.stx_mode & 0o022 != 0
    {
        return Err(ElfRefusal::WritableObject);
    }
    let mut objects = Vec::with_capacity(NAMES.len());
    for (ordinal, name) in NAMES.into_iter().enumerate() {
        let file: File = openat2(
            root,
            name,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
            ResolveFlags::BENEATH
                | ResolveFlags::NO_SYMLINKS
                | ResolveFlags::NO_MAGICLINKS
                | ResolveFlags::NO_XDEV,
        )
        .map_err(|_| ElfRefusal::Inventory)?
        .into();
        let object_stat = statx(
            &file,
            c"",
            AtFlags::EMPTY_PATH,
            StatxFlags::BASIC_STATS | StatxFlags::MNT_ID,
        )
        .map_err(|_| ElfRefusal::Inventory)?;
        if object_stat.stx_mask & (StatxFlags::BASIC_STATS | StatxFlags::MNT_ID).bits()
            != (StatxFlags::BASIC_STATS | StatxFlags::MNT_ID).bits()
            || object_stat.stx_mode & 0o170_000 != 0o100_000
            || object_stat.stx_nlink != 1
            || object_stat.stx_mode & 0o222 != 0
            || object_stat.stx_uid != root_stat.stx_uid
            || object_stat.stx_gid != root_stat.stx_gid
            || object_stat.stx_mnt_id != root_stat.stx_mnt_id
        {
            return Err(ElfRefusal::WritableObject);
        }
        let bytes = read_bounded(&file, object_stat.stx_size)?;
        let after = statx(
            &file,
            c"",
            AtFlags::EMPTY_PATH,
            StatxFlags::BASIC_STATS | StatxFlags::MNT_ID,
        )
        .map_err(|_| ElfRefusal::Inventory)?;
        if !same_statx(&object_stat, &after) {
            return Err(ElfRefusal::Inventory);
        }
        if bytes.len() != expected_objects[ordinal].len()
            || sha256(&bytes) != sha256(&expected_objects[ordinal])
        {
            return Err(ElfRefusal::Digest);
        }
        objects.push(bytes);
    }
    if runtime_directory_names(root)? != NAMES {
        return Err(ElfRefusal::Inventory);
    }
    let root_after = statx(
        root,
        c"",
        AtFlags::EMPTY_PATH,
        StatxFlags::BASIC_STATS | StatxFlags::MNT_ID,
    )
    .map_err(|_| ElfRefusal::Inventory)?;
    if !same_statx(&root_stat, &root_after) {
        return Err(ElfRefusal::Inventory);
    }

    let front = parse_component(
        &objects[0],
        ExpectedLinkage::Dynamic,
        Some("runtime-loader"),
        Some(&["libsynthetic.so"]),
    )?;
    let dependency = parse_component(&objects[1], ExpectedLinkage::Shared, None, Some(&[]))?;
    let loader = parse_component(&objects[2], ExpectedLinkage::Shared, None, Some(&[]))?;
    let delegate = parse_component(&objects[3], ExpectedLinkage::Static, None, Some(&[]))?;
    Ok(SyntheticRuntimeComponents {
        front,
        delegate,
        loader,
        dependency,
        marker: EvidenceMarker::new(),
    })
}

#[cfg(test)]
fn same_statx(left: &rustix::fs::Statx, right: &rustix::fs::Statx) -> bool {
    left.stx_dev_major == right.stx_dev_major
        && left.stx_dev_minor == right.stx_dev_minor
        && left.stx_ino == right.stx_ino
        && left.stx_mode == right.stx_mode
        && left.stx_uid == right.stx_uid
        && left.stx_gid == right.stx_gid
        && left.stx_nlink == right.stx_nlink
        && left.stx_size == right.stx_size
        && left.stx_mnt_id == right.stx_mnt_id
        && left.stx_ctime.tv_sec == right.stx_ctime.tv_sec
        && left.stx_ctime.tv_nsec == right.stx_ctime.tv_nsec
        && left.stx_mtime.tv_sec == right.stx_mtime.tv_sec
        && left.stx_mtime.tv_nsec == right.stx_mtime.tv_nsec
}

#[cfg(test)]
fn runtime_directory_names(root: &File) -> Result<Vec<String>, ElfRefusal> {
    use std::mem::MaybeUninit;

    use rustix::fs::RawDir;

    let scan = openat2(
        root,
        c".",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|_| ElfRefusal::Inventory)?;
    let mut buffer = [MaybeUninit::uninit(); 8_192];
    let mut raw = RawDir::new(scan, &mut buffer);
    let mut names = Vec::new();
    while let Some(entry) = raw.next() {
        let entry = entry.map_err(|_| ElfRefusal::Inventory)?;
        if entry.file_name() == c"." || entry.file_name() == c".." {
            continue;
        }
        names.push(
            entry
                .file_name()
                .to_str()
                .map_err(|_| ElfRefusal::Inventory)?
                .to_owned(),
        );
        if names.len() > 4 {
            return Err(ElfRefusal::Inventory);
        }
    }
    names.sort_unstable();
    Ok(names)
}

#[cfg(test)]
pub(crate) fn synthetic_elf(
    linkage: Linkage,
    interpreter: Option<&str>,
    needed: &[&str],
) -> Vec<u8> {
    const EH_SIZE: usize = 64;
    const PH_SIZE: usize = 56;
    let dynamic = linkage == Linkage::DynamicExecutable;
    let ph_count = 1 + usize::from(interpreter.is_some()) + usize::from(dynamic);
    let data_start = (EH_SIZE + ph_count * PH_SIZE).next_multiple_of(16);
    let interp_bytes = interpreter.map(|value| {
        let mut bytes = value.as_bytes().to_vec();
        bytes.push(0);
        bytes
    });
    let dynamic_offset =
        (data_start + interp_bytes.as_ref().map_or(0, Vec::len)).next_multiple_of(16);
    let dynamic_count = needed.len() + 3;
    let strings_offset = dynamic_offset + dynamic_count * 16;
    let mut strings = vec![0_u8];
    let mut needed_offsets = Vec::new();
    for name in needed {
        needed_offsets.push(strings.len() as u64);
        strings.extend_from_slice(name.as_bytes());
        strings.push(0);
    }
    let file_size = if dynamic {
        strings_offset + strings.len()
    } else {
        data_start + interp_bytes.as_ref().map_or(1, Vec::len)
    };
    let mut bytes = vec![0_u8; file_size];
    bytes[..4].copy_from_slice(b"\x7fELF");
    bytes[4] = header::ELFCLASS64;
    bytes[5] = header::ELFDATA2LSB;
    bytes[6] = header::EV_CURRENT;
    put_u16(
        &mut bytes,
        16,
        match linkage {
            Linkage::StaticExecutable => header::ET_EXEC,
            _ => header::ET_DYN,
        },
    );
    put_u16(&mut bytes, 18, header::EM_X86_64);
    put_u32(&mut bytes, 20, u32::from(header::EV_CURRENT));
    put_u64(
        &mut bytes,
        24,
        if linkage == Linkage::SharedObject {
            0
        } else {
            data_start as u64
        },
    );
    put_u64(&mut bytes, 32, EH_SIZE as u64);
    put_u16(&mut bytes, 52, EH_SIZE as u16);
    put_u16(&mut bytes, 54, PH_SIZE as u16);
    put_u16(&mut bytes, 56, ph_count as u16);

    write_ph(
        &mut bytes,
        EH_SIZE,
        ProgramHeaderFixture {
            kind: program_header::PT_LOAD,
            flags: program_header::PF_R | program_header::PF_X,
            offset: 0,
            virtual_address: 0,
            file_size: file_size as u64,
            memory_size: file_size as u64,
            align: 0x1000,
        },
    );
    let mut ph = 1;
    if let Some(interpreter_bytes) = &interp_bytes {
        write_ph(
            &mut bytes,
            EH_SIZE + ph * PH_SIZE,
            ProgramHeaderFixture {
                kind: program_header::PT_INTERP,
                flags: program_header::PF_R,
                offset: data_start as u64,
                virtual_address: data_start as u64,
                file_size: interpreter_bytes.len() as u64,
                memory_size: interpreter_bytes.len() as u64,
                align: 1,
            },
        );
        bytes[data_start..data_start + interpreter_bytes.len()].copy_from_slice(interpreter_bytes);
        ph += 1;
    }
    if dynamic {
        write_ph(
            &mut bytes,
            EH_SIZE + ph * PH_SIZE,
            ProgramHeaderFixture {
                kind: program_header::PT_DYNAMIC,
                flags: program_header::PF_R,
                offset: dynamic_offset as u64,
                virtual_address: dynamic_offset as u64,
                file_size: (dynamic_count * 16) as u64,
                memory_size: (dynamic_count * 16) as u64,
                align: 8,
            },
        );
        let mut index = 0;
        put_dyn(
            &mut bytes,
            dynamic_offset + index * 16,
            goblin::elf::dynamic::DT_STRTAB,
            strings_offset as u64,
        );
        index += 1;
        put_dyn(
            &mut bytes,
            dynamic_offset + index * 16,
            goblin::elf::dynamic::DT_STRSZ,
            strings.len() as u64,
        );
        index += 1;
        for needed_offset in needed_offsets {
            put_dyn(
                &mut bytes,
                dynamic_offset + index * 16,
                goblin::elf::dynamic::DT_NEEDED,
                needed_offset,
            );
            index += 1;
        }
        put_dyn(
            &mut bytes,
            dynamic_offset + index * 16,
            goblin::elf::dynamic::DT_NULL,
            0,
        );
        bytes[strings_offset..].copy_from_slice(&strings);
    }
    bytes
}

#[cfg(test)]
struct ProgramHeaderFixture {
    kind: u32,
    flags: u32,
    offset: u64,
    virtual_address: u64,
    file_size: u64,
    memory_size: u64,
    align: u64,
}

#[cfg(test)]
fn write_ph(bytes: &mut [u8], at: usize, header: ProgramHeaderFixture) {
    put_u32(bytes, at, header.kind);
    put_u32(bytes, at + 4, header.flags);
    put_u64(bytes, at + 8, header.offset);
    put_u64(bytes, at + 16, header.virtual_address);
    put_u64(bytes, at + 24, header.virtual_address);
    put_u64(bytes, at + 32, header.file_size);
    put_u64(bytes, at + 40, header.memory_size);
    put_u64(bytes, at + 48, header.align);
}

#[cfg(test)]
fn put_dyn(bytes: &mut [u8], at: usize, tag: u64, value: u64) {
    put_u64(bytes, at, tag);
    put_u64(bytes, at + 8, value);
}
#[cfg(test)]
fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}
#[cfg(test)]
fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
#[cfg(test)]
fn put_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
pub(crate) fn parse_component_for_test(
    bytes: &[u8],
    linkage: Linkage,
    interpreter: Option<&str>,
    needed: &[&str],
) -> Result<ElfComponent, ElfRefusal> {
    let expected = match linkage {
        Linkage::DynamicExecutable => ExpectedLinkage::Dynamic,
        Linkage::StaticExecutable => ExpectedLinkage::Static,
        Linkage::SharedObject => ExpectedLinkage::Shared,
    };
    parse_component(bytes, expected, interpreter, Some(needed))
}
