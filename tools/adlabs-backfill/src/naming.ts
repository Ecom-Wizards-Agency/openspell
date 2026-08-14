/**
 * What a backfill archive file is called, and why it is deliberately not called
 * what a crosscheck export is called.
 *
 * The crosscheck watches an inbox for `adlabs_<grain>_<profileId>_<start>_<end>`
 * `[_marker].csv` and ingests anything that matches. A backfill file named
 * `adlabs_campaign_…_bf.csv` **would** match — `bf` reads as the optional
 * marker — and would be compared against our own facts as though it were a
 * fresh incumbent export. That is the same poisoning the source column guards
 * against, arriving through the filesystem instead of the database.
 *
 * So the prefix is `adlabsbf_` and the root is `_local/backfill/`, and
 * `naming.test.ts` asserts that no name this module can produce matches the
 * crosscheck's pattern. Structurally impossible beats carefully avoided: the
 * two contracts cannot be confused by a tired operator at 1am, because the
 * regex physically cannot match. This extends the export contract rather than
 * changing it — §2 of `docs/adlabs-export-contract.md` is untouched.
 */
import { join } from 'node:path';

/** The grains a backfill can archive. Phase 0 is `profile`; Phase 1 the rest. */
export const BACKFILL_GRAINS = [
  'profiles',
  'profile',
  'campaign',
  'ad_group',
  'target',
  'placement',
  'search_term',
  'search_query',
] as const;
export type BackfillGrain = (typeof BACKFILL_GRAINS)[number];

/** The prefix that cannot be mistaken for a crosscheck inbox export. */
export const BACKFILL_PREFIX = 'adlabsbf';

/** The archive root, relative to the repo. Gitignored, like everything in `_local/`. */
export const BACKFILL_ROOT = '_local/backfill';

/**
 * The scope of a profile-grain pull. One `timeline` call returns every profile
 * at once, so its file belongs to all of them and to none of them.
 */
export const ALL_PROFILES = 'all';

export interface BackfillFileName {
  grain: BackfillGrain;
  /** An Amazon profile id, or `all` for the one file that covers every profile. */
  scope: string;
  startDate: string;
  endDate: string;
}

export class BackfillNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillNameError';
  }
}

const FILE_NAME = new RegExp(
  `^${BACKFILL_PREFIX}_(${BACKFILL_GRAINS.join('|')})_([A-Za-z0-9-]+)_(\\d{4}-\\d{2}-\\d{2})_(\\d{4}-\\d{2}-\\d{2})\\.csv$`,
);

export function backfillFileName(
  grain: BackfillGrain,
  scope: string,
  startDate: string,
  endDate: string,
): string {
  if (!/^[A-Za-z0-9-]+$/.test(scope)) {
    throw new BackfillNameError(`scope "${scope}" is not an id or "${ALL_PROFILES}"`);
  }
  if (endDate < startDate) {
    throw new BackfillNameError(`window ends (${endDate}) before it starts (${startDate})`);
  }
  return `${BACKFILL_PREFIX}_${grain}_${scope}_${startDate}_${endDate}.csv`;
}

export function isBackfillFileName(name: string): boolean {
  return FILE_NAME.test(basename(name));
}

export function parseBackfillFileName(name: string): BackfillFileName {
  const source = basename(name);
  const match = FILE_NAME.exec(source);
  if (!match) {
    throw new BackfillNameError(
      `"${source}" is not ${BACKFILL_PREFIX}_<grain>_<scope>_<start>_<end>.csv`,
    );
  }
  const [, grain, scope, startDate, endDate] = match as unknown as [
    string,
    BackfillGrain,
    string,
    string,
    string,
  ];
  return { grain, scope, startDate, endDate };
}

/** `<root>/<scope>/<grain>/<name>`. The scope directory is what a client hand-over deletes. */
export function backfillFilePath(root: string, file: BackfillFileName): string {
  return join(root, file.scope, file.grain, backfillFileName(file.grain, file.scope, file.startDate, file.endDate));
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? name;
}
