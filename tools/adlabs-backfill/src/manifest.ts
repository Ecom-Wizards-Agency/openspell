/**
 * The manifest: one line per archived file, so a rerun is a no-op and a verdict
 * is auditable years later.
 *
 * JSONL and append-only, because two things must remain true: a crashed run
 * must leave a readable file, and a later run must be able to tell what has
 * already been pulled without re-reading gigabytes of CSV. The hash is the
 * reason it can — a file whose sha256 is already in the manifest is the same
 * file.
 *
 * What is deliberately NOT in a manifest line: the download URL. AdLabs'
 * `download_data` returns a plain HTTPS link with the bearer inside it, valid
 * for fifteen minutes. Fifteen minutes is long enough for a manifest to be
 * committed, pasted into a run note, or shipped to a log aggregator, so the URL
 * never leaves the process that used it.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BackfillGrain } from './naming.js';

export const MANIFEST_NAME = 'manifest.jsonl';

export interface ManifestEntry {
  grain: BackfillGrain;
  /** Amazon profile id, or `all`. */
  scope: string;
  startDate: string;
  endDate: string;
  /** The archived file's name, not its path: the root moves, the name does not. */
  file: string;
  bytes: number;
  /** Data rows in the file, header excluded. */
  rows: number;
  sha256: string;
  pulledAt: string;
  /** Filled by the loader once the rows are in the database. */
  rowsEligible?: number;
  rowsLoaded?: number;
  /** `report_requests.id` for a Phase 0 load; rollups carry no ledger row. */
  reportRequestId?: string;
  loadedAt?: string;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_NAME);
}

export async function appendManifest(root: string, entry: ManifestEntry): Promise<void> {
  const path = manifestPath(root);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Every line in the manifest, oldest first. A missing manifest is an empty one. */
export async function readManifest(root: string): Promise<ManifestEntry[]> {
  const text = await readFile(manifestPath(root), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ManifestEntry);
}
