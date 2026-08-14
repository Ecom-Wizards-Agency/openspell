/**
 * The inbox: a directory an operator-side agent drops AdLabs exports into.
 *
 * Deliberately a directory of files and not a bucket client. A file that exists
 * on disk can be re-read, diffed and shown to a human when a verdict is
 * disputed, and the same code path works against a mounted bucket. What the
 * watcher must never do is delete an export it has ingested: the export is the
 * evidence for the verdict, so it moves to `processed/` and stays there.
 */
import { readdir, readFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isExportFileName, parseExportFileName } from './contract.js';
import type { ExportFileName } from './contract.js';

export const PROCESSED_DIR = 'processed';

export interface InboxEntry {
  /** Absolute or inbox-relative path, whatever `scanInbox` was given. */
  path: string;
  name: string;
  file: ExportFileName;
}

export interface ScanInboxOptions {
  /** Only exports for this Amazon profile id. */
  amazonProfileId?: string;
  /** Only exports whose window ends on or after this date. */
  since?: string;
}

/**
 * Every file in the inbox that matches the naming contract, oldest window
 * first. Files that do not match are ignored rather than rejected: an inbox is
 * a shared folder and a stray README is not an incident.
 */
export async function scanInbox(
  directory: string,
  options: ScanInboxOptions = {},
): Promise<InboxEntry[]> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });

  const entries: InboxEntry[] = [];
  for (const name of names) {
    if (!isExportFileName(name)) continue;
    const file = parseExportFileName(name);
    if (options.amazonProfileId !== undefined && file.amazonProfileId !== options.amazonProfileId) {
      continue;
    }
    if (options.since !== undefined && file.endDate < options.since) continue;
    entries.push({ path: join(directory, name), name, file });
  }

  return entries.sort((left, right) =>
    left.file.startDate === right.file.startDate
      ? left.name.localeCompare(right.name)
      : left.file.startDate.localeCompare(right.file.startDate),
  );
}

export async function readExportFile(entry: InboxEntry): Promise<string> {
  return readFile(entry.path, 'utf8');
}

/** Move an ingested export into `processed/`. Never deletes. */
export async function markProcessed(directory: string, entry: InboxEntry): Promise<string> {
  const target = join(directory, PROCESSED_DIR);
  await mkdir(target, { recursive: true });
  const destination = join(target, entry.name);
  await rename(entry.path, destination);
  return destination;
}
