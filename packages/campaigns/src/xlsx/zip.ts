/**
 * A ZIP container, written and read by hand.
 *
 * An .xlsx is a ZIP of XML parts, so producing one needs a ZIP writer. This is
 * about a hundred and fifty lines of it instead of a dependency, for three
 * reasons that all point the same way: the engine stays pure (no `node:zlib`,
 * no `node:fs`, nothing to stub in a test), the lockfile stays untouched while
 * seven packages are being built in parallel, and the reader below lets a test
 * open the file it just wrote instead of trusting that it wrote one.
 *
 * Entries are STORED, never deflated. An uncompressed ZIP is a valid ZIP; Excel
 * and openpyxl both read one without noticing, and a bulksheet is small enough
 * that the bytes saved would not pay for the compressor.
 *
 * Timestamps are fixed rather than current, so the same plan produces the same
 * file every time it is exported. A workbook that differs only in its mtime is
 * a workbook nobody can diff.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

/** 1980-01-01 00:00:00 in MS-DOS date/time, the earliest a ZIP can express. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    const index = (crc ^ (data[i] as number)) & 0xff;
    crc = (CRC_TABLE[index] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A little-endian byte sink. ZIP is little-endian throughout. */
class ByteWriter {
  private readonly chunks: Uint8Array[] = [];

  private length = 0;

  get offset(): number {
    return this.length;
  }

  bytes(value: Uint8Array): void {
    this.chunks.push(value);
    this.length += value.length;
  }

  u16(value: number): void {
    this.bytes(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.bytes(new Uint8Array([
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ]));
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const writer = new ByteWriter();
  const directory: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const offset = writer.offset;

    writer.u32(LOCAL_HEADER);
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // stored
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(crc);
    writer.u32(entry.data.length);
    writer.u32(entry.data.length);
    writer.u16(name.length);
    writer.u16(0); // extra
    writer.bytes(name);
    writer.bytes(entry.data);

    directory.push({ name, crc, size: entry.data.length, offset });
  }

  const directoryOffset = writer.offset;
  for (const record of directory) {
    writer.u32(CENTRAL_HEADER);
    writer.u16(20); // version made by
    writer.u16(20); // version needed
    writer.u16(0); // flags
    writer.u16(0); // stored
    writer.u16(DOS_TIME);
    writer.u16(DOS_DATE);
    writer.u32(record.crc);
    writer.u32(record.size);
    writer.u32(record.size);
    writer.u16(record.name.length);
    writer.u16(0); // extra
    writer.u16(0); // comment
    writer.u16(0); // disk
    writer.u16(0); // internal attributes
    writer.u32(0); // external attributes
    writer.u32(record.offset);
    writer.bytes(record.name);
  }
  const directorySize = writer.offset - directoryOffset;

  writer.u32(END_OF_CENTRAL_DIRECTORY);
  writer.u16(0); // this disk
  writer.u16(0); // disk with the directory
  writer.u16(directory.length);
  writer.u16(directory.length);
  writer.u32(directorySize);
  writer.u32(directoryOffset);
  writer.u16(0); // comment

  return writer.concat();
}

function u16At(data: Uint8Array, at: number): number {
  return (data[at] as number) | ((data[at + 1] as number) << 8);
}

function u32At(data: Uint8Array, at: number): number {
  return (
    ((data[at] as number)
      | ((data[at + 1] as number) << 8)
      | ((data[at + 2] as number) << 16)
      | ((data[at + 3] as number) << 24)) >>> 0
  );
}

/**
 * Read a ZIP back into its entries.
 *
 * STORED only, and it says so rather than returning nonsense: this reader
 * exists to verify what this writer produced, and quietly mis-reading a
 * deflated archive would defeat the purpose.
 */
export function readZip(data: Uint8Array): Map<string, Uint8Array> {
  let eocd = -1;
  for (let at = data.length - 22; at >= 0; at -= 1) {
    if (u32At(data, at) === END_OF_CENTRAL_DIRECTORY) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive: no end-of-central-directory record');

  const count = u16At(data, eocd + 10);
  let at = u32At(data, eocd + 16);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i += 1) {
    if (u32At(data, at) !== CENTRAL_HEADER) throw new Error('corrupt ZIP: bad central directory entry');
    const method = u16At(data, at + 10);
    const size = u32At(data, at + 24);
    const nameLength = u16At(data, at + 28);
    const extraLength = u16At(data, at + 30);
    const commentLength = u16At(data, at + 32);
    const localOffset = u32At(data, at + 42);
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`unsupported compression in ${name}: this reader is STORED-only`);

    const localNameLength = u16At(data, localOffset + 26);
    const localExtraLength = u16At(data, localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    out.set(name, data.subarray(start, start + size));

    at += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}
