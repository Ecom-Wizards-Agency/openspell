/**
 * Payload decoding for report and export downloads.
 *
 * Amazon says `format: GZIP_JSON` and usually means it, but the pre-signed S3
 * URL is sometimes served with `Content-Encoding: gzip`, in which case the HTTP
 * layer has already decompressed the body and a second gunzip throws. The
 * reference tolerates exactly this (`_download_report` swallows the OSError);
 * here the tolerance is explicit — sniff the two magic bytes instead of
 * catching an exception, so a genuinely corrupt gzip still fails loudly.
 */
import { gunzipSync } from 'node:zlib';
import { AdsApiParseError } from './errors.js';

/** gzip's magic number: 0x1f 0x8b. */
export function looksGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export interface DecodedPayload {
  text: string;
  /** Bytes as they came off the wire, before any decompression. */
  downloadedBytes: number;
  /** Bytes after decompression, equal to `downloadedBytes` when not gzipped. */
  decodedBytes: number;
  gzipped: boolean;
}

export function decodePayload(bytes: Uint8Array): DecodedPayload {
  const gzipped = looksGzipped(bytes);
  const decoder = new TextDecoder();
  if (!gzipped) {
    return {
      text: decoder.decode(bytes),
      downloadedBytes: bytes.length,
      decodedBytes: bytes.length,
      gzipped: false,
    };
  }
  let inflated: Uint8Array;
  try {
    inflated = gunzipSync(bytes);
  } catch (cause) {
    throw new AdsApiParseError('payload announced gzip but failed to decompress', cause);
  }
  return {
    text: decoder.decode(inflated),
    downloadedBytes: bytes.length,
    decodedBytes: inflated.length,
    gzipped: true,
  };
}

/**
 * Decode and parse a downloaded JSON array.
 *
 * Amazon returns a flat array of objects for both reports and exports. Anything
 * else is a contract change, and this throws rather than coercing it into an
 * empty result — silent emptiness is indistinguishable from a genuinely empty
 * report, and one of those two is a data-loss bug.
 */
export function decodeJsonArray(bytes: Uint8Array, what: string): {
  rows: Record<string, unknown>[];
  payload: DecodedPayload;
} {
  const payload = decodePayload(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.text);
  } catch (cause) {
    throw new AdsApiParseError(`${what} download is not JSON`, cause);
  }
  if (!Array.isArray(parsed)) {
    throw new AdsApiParseError(
      `${what} download is ${typeof parsed}, expected a JSON array of rows`,
    );
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, row] of parsed.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new AdsApiParseError(`${what} row ${index} is not an object`);
    }
    rows.push(row as Record<string, unknown>);
  }
  return { rows, payload };
}
