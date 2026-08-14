/**
 * The AdLabs export contract: what an inbox file must be called, which columns
 * it must carry, and what we refuse to read.
 *
 * The exports are pulled by an operator-side agent through the AdLabs MCP
 * (`download_data` on a filtered reference), so nothing here talks to AdLabs.
 * This module is the border control: a file either states its profile, grain
 * and window in a form we can check, or it does not get compared.
 *
 * Two provider quirks are handled here rather than discovered later:
 *
 *  - `get_entity_data` returns **every profile the team can see**, whatever
 *    `profile_id` was asked for. So when the export carries a profile column we
 *    filter on it and count what we dropped; when it does not, the filename is
 *    the only claim of scope and is checked against the job.
 *  - The in-progress day reads 0 in the `total_*` columns. The window in the
 *    filename may therefore include a day that is not really there, which is
 *    the same day our own facts mark provisional. Both are excluded in
 *    `compare`, never here: dropping a row at parse time loses the evidence
 *    that it was dropped.
 *
 * The human-readable version of this contract lives in
 * `docs/adlabs-export-contract.md`; that document and this file are one thing
 * described twice, so change them together.
 */
import { parseCsv, parseNumber } from './csv.js';
import type { CsvDelimiter, CsvTable } from './csv.js';

/** Which grain an export carries. `campaign` rolls up to a campaign-week verdict. */
export type ExportGrain = 'profile' | 'campaign';

export interface ExportFileName {
  grain: ExportGrain;
  /** Amazon's profile id, as it appears in `ad_profiles.amazon_profile_id`. */
  amazonProfileId: string;
  /** Inclusive window, ISO dates. */
  startDate: string;
  endDate: string;
}

export interface AdlabsProfileDay {
  date: string;
  amazonProfileId: string | null;
  adSpend: number | null;
  adSales: number | null;
  totalSales: number | null;
}

export interface AdlabsCampaignRow {
  campaignId: string;
  campaignName: string | null;
  /** Present only when the export was pulled with a daily breakdown. */
  date: string | null;
  amazonProfileId: string | null;
  adSpend: number | null;
  adSales: number | null;
}

export interface ParsedExport {
  file: ExportFileName;
  /** Basename, recorded on every result row as its provenance. */
  source: string;
  delimiter: CsvDelimiter;
  /** Data rows in the file. */
  rowsParsed: number;
  /** Rows that survived the profile filter. `rowsParsed - rowsKept` is the quirk above. */
  rowsKept: number;
  profileDays: AdlabsProfileDay[];
  campaigns: AdlabsCampaignRow[];
}

export class ExportContractError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = 'ExportContractError';
  }
}

/**
 * `adlabs_<grain>_<amazonProfileId>_<startDate>_<endDate>[_anything].csv`
 *
 * The profile id and the window are in the name because a CSV in an inbox is
 * otherwise unattributable, and an export compared against the wrong profile
 * produces a confident, wrong verdict.
 */
const FILE_NAME = /^adlabs_(profile|campaign)_([A-Za-z0-9-]+)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:_[A-Za-z0-9-]+)?\.csv$/;

export function isExportFileName(name: string): boolean {
  return FILE_NAME.test(basename(name));
}

export function parseExportFileName(name: string): ExportFileName {
  const source = basename(name);
  const match = FILE_NAME.exec(source);
  if (!match) {
    throw new ExportContractError(
      source,
      'name does not match adlabs_<grain>_<profileId>_<start>_<end>.csv',
    );
  }
  const [, grain, amazonProfileId, startDate, endDate] = match as unknown as [
    string,
    ExportGrain,
    string,
    string,
    string,
  ];
  if (endDate < startDate) {
    throw new ExportContractError(source, `window ends (${endDate}) before it starts (${startDate})`);
  }
  return { grain, amazonProfileId, startDate, endDate };
}

/** Column aliases. AdLabs' own names first, then the ones a hand-built export uses. */
const COLUMNS = {
  date: ['date', 'report_date', 'day'],
  profile: ['profile_id', 'amazon_profile_id', 'profile', 'profile_amazon_id'],
  campaignId: ['campaign_id', 'campaign_global_id'],
  campaignName: ['campaign_name', 'campaign'],
  adSpend: ['spend', 'ad_spend', 'cost'],
  adSales: ['sales', 'ad_sales', 'attributed_sales'],
  totalSales: ['total_sales'],
} as const;

const REQUIRED: Record<ExportGrain, (keyof typeof COLUMNS)[]> = {
  profile: ['date', 'adSpend', 'adSales'],
  campaign: ['campaignId', 'adSpend', 'adSales'],
};

export interface ParseExportOptions {
  /**
   * The profile the job is about. Rows naming a different profile are dropped
   * (the `get_entity_data` quirk); a filename naming a different profile is an
   * error, because that is a mis-filed export rather than a wide one.
   */
  amazonProfileId?: string;
}

export function parseExport(
  name: string,
  text: string,
  options: ParseExportOptions = {},
): ParsedExport {
  const source = basename(name);
  const file = parseExportFileName(source);

  if (options.amazonProfileId !== undefined && options.amazonProfileId !== file.amazonProfileId) {
    throw new ExportContractError(
      source,
      `names profile ${file.amazonProfileId}, but the job is for ${options.amazonProfileId}`,
    );
  }

  const table = parseCsv(text);
  const column = resolveColumns(source, table, file.grain);

  const profileDays: AdlabsProfileDay[] = [];
  const campaigns: AdlabsCampaignRow[] = [];
  let rowsKept = 0;

  for (const [index, row] of table.rows.entries()) {
    const rowProfile = column.profile ? emptyToNull(row[column.profile]) : null;
    // Wide export, narrow job: this is the documented quirk, not a fault.
    if (rowProfile !== null && rowProfile !== file.amazonProfileId) continue;
    rowsKept += 1;

    const adSpend = parseNumber(row[column.adSpend], table.delimiter);
    const adSales = parseNumber(row[column.adSales], table.delimiter);

    if (file.grain === 'profile') {
      const date = normalizeDate(source, index, row[column.date ?? '']);
      profileDays.push({
        date,
        amazonProfileId: rowProfile,
        adSpend,
        adSales,
        totalSales: column.totalSales
          ? parseNumber(row[column.totalSales], table.delimiter)
          : null,
      });
      continue;
    }

    const campaignId = emptyToNull(row[column.campaignId]);
    if (campaignId === null) {
      throw new ExportContractError(source, `row ${index + 2} has no campaign id`);
    }
    campaigns.push({
      campaignId,
      campaignName: column.campaignName ? emptyToNull(row[column.campaignName]) : null,
      date: column.date ? normalizeDate(source, index, row[column.date]) : null,
      amazonProfileId: rowProfile,
      adSpend,
      adSales,
    });
  }

  return {
    file,
    source,
    delimiter: table.delimiter,
    rowsParsed: table.rows.length,
    rowsKept,
    profileDays,
    campaigns,
  };
}

interface ResolvedColumns {
  date?: string;
  profile?: string;
  campaignId: string;
  campaignName?: string;
  adSpend: string;
  adSales: string;
  totalSales?: string;
}

function resolveColumns(source: string, table: CsvTable, grain: ExportGrain): ResolvedColumns {
  const found: Partial<Record<keyof typeof COLUMNS, string>> = {};
  for (const [key, aliases] of Object.entries(COLUMNS) as [
    keyof typeof COLUMNS,
    readonly string[],
  ][]) {
    found[key] = aliases.find((alias) => table.columns.includes(alias));
  }

  const missing = REQUIRED[grain].filter((key) => found[key] === undefined);
  if (missing.length > 0) {
    const wanted = missing.map((key) => COLUMNS[key].join('|')).join(', ');
    throw new ExportContractError(
      source,
      `missing required ${grain}-grain column(s): ${wanted}. Found: ${table.columns.join(', ')}`,
    );
  }

  return {
    ...found,
    // Checked by REQUIRED above; the cast keeps the call sites honest.
    campaignId: found.campaignId ?? '',
    adSpend: found.adSpend as string,
    adSales: found.adSales as string,
  };
}

function normalizeDate(source: string, index: number, value: string | undefined): string {
  const text = (value ?? '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (iso?.[1]) return iso[1];
  const slashed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (slashed) return `${slashed[3]}-${slashed[1]}-${slashed[2]}`;
  throw new ExportContractError(source, `row ${index + 2} has an unreadable date: "${text}"`);
}

function emptyToNull(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] ?? name;
}
