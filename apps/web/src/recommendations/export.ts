/**
 * The export bridge: accepted proposals to the two files the operator flow eats.
 *
 * v1 writes NOTHING to Amazon. The apply path is an export, and the existing
 * Python staged-apply flow is the executor. That means two artifacts, and they
 * are not interchangeable:
 *
 *   rows JSON   byte-compatible with `amazon-ppc-management/batches.py`. Its
 *               `validate` subcommand is the compatibility oracle, so the
 *               serializer is `serializeApplyRows` from `packages/shared` and
 *               nothing here re-implements it.
 *   caps JSON   the flags that same `validate` run needs — the group's change
 *               caps and target ACOS — plus the exact command line, because a
 *               caps-are-ceilings check run without caps checks nothing and
 *               exits 0.
 *   workbook    Bulk Operations 2.0 XLSX, update rows only for changes to
 *               existing entities, plus create rows for proposed negatives.
 *
 * ## Two bulksheet rules this file exists to not break
 *
 * **Blank means unchanged.** An update row carries the ids that address the
 * entity and the one field being changed. Populating anything else would push
 * a value the operator never proposed.
 *
 * **Portfolio ID must be re-included on a campaign update.** Omitting it
 * *removes the campaign from its portfolio* — the highest-risk silent data loss
 * in the whole spec (bulksheets-2.0 reference §4.3). So a campaign row is only
 * emitted when the entity mirror knows that campaign, and its portfolio id
 * travels with it. A campaign we cannot resolve is skipped with a stated
 * warning rather than exported with a blank portfolio.
 */
import { SP_COLUMNS, writeWorkbook } from '@wizard-ads/campaigns';
import { serializeApplyRows } from '@wizard-ads/shared';

/** Matches `@wizard-ads/campaigns`' own sheet name, so both files look alike. */
const SHEET_NAME = 'Sponsored Products Campaigns';

/** ISO-8601 week number. Weeks start Monday and week 1 holds January 4th. */
export function isoWeek(date: string): { year: number; week: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const time = Date.UTC(y, m - 1, d);
  // ISO days run Monday=1 to Sunday=7, which is the whole subtlety: a Sunday
  // belongs to the week that *started* six days earlier, so its Thursday is
  // three days behind it and can fall in the previous ISO year.
  const isoDay = new Date(time).getUTCDay() || 7;
  const thursday = new Date(time + (4 - isoDay) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstDay = new Date(firstThursday).getUTCDay();
  const week1Monday = firstThursday - ((firstDay === 0 ? 6 : firstDay - 1) * 86_400_000);
  const week = Math.floor((thursday.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return { year, week };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * `<client>-<YYYY>W<ww>-<group>-<lever>`, the tag shape `batches.py` documents.
 *
 * Ours has to match theirs because the tag is the only join between our
 * `apply_batches` row and the batch file the Python flow writes: an operator
 * looking at one has to be able to find the other.
 */
export function batchTag(input: {
  client: string;
  date: string;
  optGroup: string;
  lever: string;
}): string {
  const { year, week } = isoWeek(input.date);
  const parts = [
    slug(input.client) || 'profile',
    `${year}W${String(week).padStart(2, '0')}`,
    slug(input.optGroup) || 'ungrouped',
    slug(input.lever) || 'other',
  ];
  return parts.join('-');
}

export interface ExportFilenames {
  rows: string;
  caps: string;
  workbook: string;
}

export function exportFilenames(tag: string): ExportFilenames {
  const safe = tag.replace(/[^A-Za-z0-9._-]+/g, '-');
  return {
    rows: `${safe}-rows.json`,
    caps: `${safe}-caps.json`,
    workbook: `${safe}-bulk.xlsx`,
  };
}

export interface CapsConfigInput {
  tag: string;
  optGroup: string;
  lever: string;
  /** Group change caps as fractions, e.g. 0.25. Null when doctrine sets none. */
  maxIncrease: number | null;
  maxDecrease: number | null;
  /** Group target ACOS as a fraction; enables the rpc x tACOS formula check. */
  targetAcos: number | null;
  atCapTolerance?: number;
}

export interface CapsConfig extends CapsConfigInput {
  schema: 'wizard-ads.export-caps.v1';
  rowsFile: string;
  atCapTolerance: number;
  /** Ready to paste. The point of the file. */
  validateCommand: string;
  notes: string[];
}

/**
 * The caps document that travels with a rows JSON.
 *
 * `batches.py validate` takes its caps as CLI flags, not as a config file, and
 * silently checks nothing when they are absent (`cap is None: continue`). So
 * the file's real payload is the command line: an operator who copies it runs
 * the check the batch was exported under, rather than the check they remember.
 */
export function capsConfig(input: CapsConfigInput): CapsConfig {
  const files = exportFilenames(input.tag);
  const atCapTolerance = input.atCapTolerance ?? 0.005;
  const flags = [`--rows ${files.rows}`];
  if (input.maxIncrease !== null) flags.push(`--max-increase ${input.maxIncrease}`);
  if (input.maxDecrease !== null) flags.push(`--max-decrease ${input.maxDecrease}`);
  flags.push(`--at-cap-tolerance ${atCapTolerance}`);
  if (input.targetAcos !== null) flags.push(`--tacos ${input.targetAcos}`);

  const notes: string[] = [];
  if (input.maxIncrease === null || input.maxDecrease === null) {
    notes.push(
      'No change cap is set for this opt group in the run\'s strategy snapshot, so validate ' +
        'will not check that direction. A cap-less validate run exits 0 without checking anything.',
    );
  }
  if (input.targetAcos === null) {
    notes.push(
      'No target ACOS in the snapshot for this group, so the rpc x target-ACOS off-formula ' +
        'check is skipped.',
    );
  }

  return {
    schema: 'wizard-ads.export-caps.v1',
    ...input,
    atCapTolerance,
    rowsFile: files.rows,
    validateCommand: `python3 batches.py validate ${flags.join(' ')}`,
    notes,
  };
}

export function serializeCapsConfig(config: CapsConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Re-exported so a caller never hand-rolls the wire format. */
export { serializeApplyRows };

// ---------------------------------------------------------------------------
// Bulk Operations workbook
// ---------------------------------------------------------------------------

export interface SheetModel {
  sheetName: string;
  header: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<string | number>>;
}

/** One proposal, with the ids a bulksheet row needs to address its entity. */
export interface BulkProposal {
  entityType: string;
  entityId: string;
  entityName: string | null;
  field: string;
  proposedValue: unknown;
  campaignId: string | null;
  adGroupId: string | null;
  /** From the entity mirror. `null` = campaign has no portfolio. */
  portfolioId: string | null;
  /** False when the entity mirror does not know this campaign. */
  campaignKnown: boolean;
}

export interface BulkWorkbook {
  sheet: SheetModel;
  bytes: Uint8Array;
  /** Proposals that could not be turned into a row, and why. */
  warnings: { entityId: string; reason: string }[];
}

type Cell = string | number;

function emptyRow(): Record<string, Cell> {
  const row: Record<string, Cell> = {};
  for (const column of SP_COLUMNS) row[column] = '';
  row['Product'] = 'Sponsored Products';
  return row;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const NEGATIVE_MATCH: Record<string, string> = {
  negative_exact: 'negativeExact',
  negative_phrase: 'negativePhrase',
};

/**
 * One proposal to one bulksheet row.
 *
 * Returns null with a reason rather than a half-populated row: a row Amazon
 * rejects is recoverable, a row that changes the wrong field is not.
 */
function rowFor(
  proposal: BulkProposal,
  tempIdFor: () => string,
): { row: Record<string, Cell> } | { reason: string } {
  const row = emptyRow();
  const bid = numeric(proposal.proposedValue);

  if (proposal.entityType === 'negative') {
    const match = NEGATIVE_MATCH[String(proposal.proposedValue)];
    if (match === undefined) return { reason: `unknown negative match type '${String(proposal.proposedValue)}'` };
    if (proposal.campaignId === null) return { reason: 'a negative needs a campaign id' };
    // A negative is a create, so its id column carries a temp id unique within
    // the file, exactly as the create semantics require.
    row['Entity'] = 'Negative Keyword';
    row['Operation'] = 'Create';
    row['Campaign ID'] = proposal.campaignId;
    row['Ad Group ID'] = proposal.adGroupId ?? '';
    row['Keyword ID'] = tempIdFor();
    row['Keyword Text'] = proposal.entityName ?? '';
    row['Match Type'] = match;
    row['State'] = 'enabled';
    return { row };
  }

  row['Operation'] = 'Update';

  if (proposal.entityType === 'keyword' || proposal.entityType === 'target') {
    if (proposal.campaignId === null || proposal.adGroupId === null) {
      return { reason: 'a target update needs both a campaign id and an ad group id' };
    }
    row['Entity'] = proposal.entityType === 'keyword' ? 'Keyword' : 'Product Targeting';
    row['Campaign ID'] = proposal.campaignId;
    row['Ad Group ID'] = proposal.adGroupId;
    row[proposal.entityType === 'keyword' ? 'Keyword ID' : 'Product Targeting ID'] = proposal.entityId;
    if (proposal.field === 'bid') {
      if (bid === null) return { reason: 'a bid update needs a numeric proposed value' };
      row['Bid'] = bid;
      return { row };
    }
    if (proposal.field === 'state') {
      row['State'] = String(proposal.proposedValue);
      return { row };
    }
    return { reason: `no bulksheet column for field '${proposal.field}' on a ${proposal.entityType}` };
  }

  if (proposal.entityType === 'ad_group') {
    if (proposal.campaignId === null) return { reason: 'an ad group update needs a campaign id' };
    row['Entity'] = 'Ad Group';
    row['Campaign ID'] = proposal.campaignId;
    row['Ad Group ID'] = proposal.entityId;
    if (proposal.field === 'bid' || proposal.field === 'default_bid') {
      if (bid === null) return { reason: 'an ad group bid update needs a numeric proposed value' };
      row['Ad Group Default Bid'] = bid;
      return { row };
    }
    if (proposal.field === 'state') {
      row['State'] = String(proposal.proposedValue);
      return { row };
    }
    return { reason: `no bulksheet column for field '${proposal.field}' on an ad group` };
  }

  if (proposal.entityType === 'campaign') {
    // §4.3: a campaign update that omits the portfolio removes the campaign
    // from it. We only emit a campaign row for a campaign the mirror knows.
    if (!proposal.campaignKnown) {
      return {
        reason:
          'this campaign is not in the synced entity mirror, so its portfolio id is unknown; ' +
          'a campaign update row that omits the portfolio would silently remove the campaign ' +
          'from its portfolio',
      };
    }
    row['Entity'] = 'Campaign';
    row['Campaign ID'] = proposal.entityId;
    if (proposal.portfolioId !== null) row['Portfolio ID'] = proposal.portfolioId;
    if (proposal.field === 'budget' || proposal.field === 'daily_budget') {
      const budget = numeric(proposal.proposedValue);
      if (budget === null) return { reason: 'a budget update needs a numeric proposed value' };
      row['Daily Budget'] = budget;
      return { row };
    }
    if (proposal.field === 'state') {
      row['State'] = String(proposal.proposedValue);
      return { row };
    }
    return { reason: `no bulksheet column for field '${proposal.field}' on a campaign` };
  }

  if (proposal.entityType === 'placement') {
    const percentage = numeric(proposal.proposedValue);
    if (percentage === null) return { reason: 'a placement update needs a numeric percentage' };
    if (proposal.campaignId === null) return { reason: 'a placement update needs a campaign id' };
    row['Entity'] = 'Bidding Adjustment';
    row['Campaign ID'] = proposal.campaignId;
    row['Placement'] = proposal.entityId;
    row['Percentage'] = percentage;
    return { row };
  }

  return { reason: `no bulksheet mapping for entity type '${proposal.entityType}'` };
}

/**
 * Build the workbook.
 *
 * Update rows first, then create rows, which is the order a reviewer reads and
 * the order Amazon's parser prefers to meet parents in.
 */
export function buildBulkWorkbook(proposals: readonly BulkProposal[]): BulkWorkbook {
  const warnings: { entityId: string; reason: string }[] = [];
  const updates: Cell[][] = [];
  const creates: Cell[][] = [];
  let tempIdCounter = 0;
  const tempIdFor = (): string => {
    tempIdCounter += 1;
    return `wa_negative_${tempIdCounter}`;
  };

  for (const proposal of proposals) {
    const result = rowFor(proposal, tempIdFor);
    if ('reason' in result) {
      warnings.push({ entityId: proposal.entityId, reason: result.reason });
      continue;
    }
    const cells = SP_COLUMNS.map((column) => result.row[column] ?? '');
    if (result.row['Operation'] === 'Create') creates.push(cells);
    else updates.push(cells);
  }

  const sheet: SheetModel = {
    sheetName: SHEET_NAME,
    header: [...SP_COLUMNS],
    rows: [...updates, ...creates],
  };
  return { sheet, bytes: writeWorkbook(sheet), warnings };
}
