/**
 * The export bridge's two files.
 *
 * The rows JSON's real oracle is the Python validator, run against a file this
 * code produced (see the WP report). What is asserted here is everything that
 * has to hold *before* that run is meaningful: the exact key set and key order
 * `batches.py` documents, the two-space indent and trailing newline its own
 * writer produces, and a workbook whose update rows change one field and carry
 * the portfolio id that a blank would silently strip.
 */
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '@wizard-ads/campaigns';
import type { ApplyRow } from '@wizard-ads/shared';
import {
  batchTag,
  buildBulkWorkbook,
  capsConfig,
  exportFilenames,
  isoWeek,
  serializeApplyRows,
  serializeCapsConfig,
} from './export';
import type { BulkProposal } from './export';

const ROWS: ApplyRow[] = [
  {
    entityType: 'keyword',
    entityId: 'kw-1',
    field: 'bid',
    old: 0.9,
    new: 0.72,
    name: 'blue widget',
    clicks: 42,
    revenue: 75.6,
  },
  { entityType: 'campaign', entityId: 'c-1', field: 'budget', old: 50, new: 65 },
];

describe('rows JSON', () => {
  it('emits batches.py\'s documented keys, in its order, with its formatting', () => {
    const text = serializeApplyRows(ROWS);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  {\n    "entity_type"');

    const parsed = JSON.parse(text) as Record<string, unknown>[];
    // The five keys `validate_rows` requires, present on every row.
    for (const row of parsed) {
      for (const key of ['entity_type', 'entity_id', 'field', 'old', 'new']) {
        expect(Object.keys(row)).toContain(key);
      }
    }
    // Key order is the contract: a diff against a Python-written file is empty.
    expect(Object.keys(parsed[0] as object)).toEqual([
      'entity_type',
      'entity_id',
      'field',
      'old',
      'new',
      'name',
      'clicks',
      'revenue',
    ]);
    // Optional keys are absent, not null: `r.get('clicks')` is falsy either
    // way, but a null would still show up in a diff against their file.
    expect(Object.keys(parsed[1] as object)).toEqual(['entity_type', 'entity_id', 'field', 'old', 'new']);
  });
});

describe('caps config', () => {
  it('assembles the exact validate command the batch was exported under', () => {
    const config = capsConfig({
      tag: 'acme-2026W33-rank-bid-down',
      optGroup: 'rank',
      lever: 'bid-down',
      maxIncrease: 0.2,
      maxDecrease: 0.3,
      targetAcos: 0.45,
    });
    expect(config.validateCommand).toBe(
      'python3 batches.py validate --rows acme-2026W33-rank-bid-down-rows.json ' +
        '--max-increase 0.2 --max-decrease 0.3 --at-cap-tolerance 0.005 --tacos 0.45',
    );
    expect(config.notes).toEqual([]);
    expect(serializeCapsConfig(config).endsWith('\n')).toBe(true);
  });

  it('says out loud that a missing cap means an unchecked direction', () => {
    const config = capsConfig({
      tag: 'acme-2026W33-rank-bid-down',
      optGroup: 'rank',
      lever: 'bid-down',
      maxIncrease: null,
      maxDecrease: null,
      targetAcos: null,
    });
    expect(config.validateCommand).not.toContain('--max-increase');
    expect(config.notes.join(' ')).toContain('exits 0 without checking anything');
    expect(config.notes.join(' ')).toContain('off-formula');
  });
});

describe('batch tag', () => {
  it('follows the ISO week the Python flow names batches by', () => {
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2026-08-14')).toEqual({ year: 2026, week: 33 });
    // The year-boundary case the naive formula gets wrong.
    expect(isoWeek('2027-01-03')).toEqual({ year: 2026, week: 53 });
    expect(
      batchTag({ client: 'Acme Widgets US', date: '2026-08-14', optGroup: 'Rank', lever: 'bid-down' }),
    ).toBe('acme-widgets-us-2026W33-rank-bid-down');
    expect(exportFilenames('acme-2026W33-rank-bid-down').rows).toBe(
      'acme-2026W33-rank-bid-down-rows.json',
    );
  });
});

function proposal(overrides: Partial<BulkProposal> = {}): BulkProposal {
  return {
    entityType: 'keyword',
    entityId: 'kw-1',
    entityName: 'blue widget',
    field: 'bid',
    proposedValue: 0.72,
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    portfolioId: null,
    campaignKnown: true,
    ...overrides,
  };
}

function cellsOf(sheet: { header: readonly string[]; rows: ReadonlyArray<ReadonlyArray<string | number>> }, index: number) {
  const row = sheet.rows[index] ?? [];
  return Object.fromEntries(sheet.header.map((column, i) => [column, row[i] ?? '']));
}

describe('bulk workbook', () => {
  it('writes an update row that changes exactly one field', () => {
    const { sheet } = buildBulkWorkbook([proposal()]);
    const row = cellsOf(sheet, 0);
    expect(row['Product']).toBe('Sponsored Products');
    expect(row['Entity']).toBe('Keyword');
    expect(row['Operation']).toBe('Update');
    expect(row['Campaign ID']).toBe('c-1');
    expect(row['Ad Group ID']).toBe('ag-1');
    expect(row['Keyword ID']).toBe('kw-1');
    expect(row['Bid']).toBe(0.72);
    // Blank means unchanged: the immutable fields stay empty rather than being
    // restated, and no other column carries a value.
    expect(row['Keyword Text']).toBe('');
    expect(row['Match Type']).toBe('');
    expect(row['State']).toBe('');
  });

  it('re-includes the portfolio id on a campaign update', () => {
    const { sheet } = buildBulkWorkbook([
      proposal({
        entityType: 'campaign',
        entityId: 'c-1',
        field: 'budget',
        proposedValue: 65,
        portfolioId: 'pf-9',
      }),
    ]);
    const row = cellsOf(sheet, 0);
    expect(row['Entity']).toBe('Campaign');
    expect(row['Daily Budget']).toBe(65);
    expect(row['Portfolio ID']).toBe('pf-9');
  });

  it('refuses a campaign row it cannot resolve rather than blanking the portfolio', () => {
    const { sheet, warnings } = buildBulkWorkbook([
      proposal({ entityType: 'campaign', entityId: 'c-9', field: 'budget', proposedValue: 65, campaignKnown: false }),
    ]);
    expect(sheet.rows).toHaveLength(0);
    expect(warnings[0]?.reason).toContain('remove the campaign from its portfolio');
  });

  it('writes proposed negatives as create rows with unique temp ids', () => {
    const { sheet } = buildBulkWorkbook([
      proposal(),
      proposal({
        entityType: 'negative',
        entityId: 'ag-1:free widget',
        entityName: 'free widget',
        field: 'negative_keyword',
        proposedValue: 'negative_exact',
      }),
      proposal({
        entityType: 'negative',
        entityId: 'ag-1:cheap widget',
        entityName: 'cheap widget',
        field: 'negative_keyword',
        proposedValue: 'negative_phrase',
      }),
    ]);
    // Update rows first, creates after.
    expect(cellsOf(sheet, 0)['Operation']).toBe('Update');
    const first = cellsOf(sheet, 1);
    const second = cellsOf(sheet, 2);
    expect(first['Entity']).toBe('Negative Keyword');
    expect(first['Operation']).toBe('Create');
    expect(first['Keyword Text']).toBe('free widget');
    expect(first['Match Type']).toBe('negativeExact');
    expect(second['Match Type']).toBe('negativePhrase');
    expect(first['Keyword ID']).not.toBe(second['Keyword ID']);
  });

  it('produces a workbook that reads back as the sheet it wrote', () => {
    const { sheet, bytes } = buildBulkWorkbook([proposal(), proposal({ entityId: 'kw-2', proposedValue: 1.15 })]);
    const read = readWorkbook(bytes);
    expect(read.header).toEqual([...sheet.header]);
    expect(read.rows).toHaveLength(2);
    expect(read.rows[1]?.[read.header.indexOf('Bid')]).toBe(1.15);
  });

  it('names what it could not write instead of dropping it silently', () => {
    const { sheet, warnings } = buildBulkWorkbook([
      proposal({ field: 'match_type', proposedValue: 'broad' }),
      proposal({ entityType: 'portfolio', entityId: 'pf-1' }),
    ]);
    expect(sheet.rows).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.reason).toContain("field 'match_type'");
    expect(warnings[1]?.reason).toContain('portfolio');
  });
});
