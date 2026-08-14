import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExportContractError,
  isExportFileName,
  parseExport,
  parseExportFileName,
} from './contract.js';
import {
  CLEAN_CAMPAIGN_EXPORT,
  CLEAN_PROFILE_EXPORT,
  EURO_PROFILE_EXPORT,
  FIXTURE_OTHER_PROFILE,
  FIXTURE_PROFILE,
  INBOX_DIR,
} from './fixtures.js';

const read = (dir: string, name: string) => readFile(join(dir, name), 'utf8');

describe('the export file name', () => {
  it('carries the grain, the profile and the window', () => {
    expect(parseExportFileName(CLEAN_PROFILE_EXPORT)).toEqual({
      grain: 'profile',
      amazonProfileId: FIXTURE_PROFILE,
      startDate: '2026-08-01',
      endDate: '2026-08-07',
    });
  });

  it('accepts a trailing pull marker and a full path', () => {
    const marked = `${CLEAN_CAMPAIGN_EXPORT.replace('.csv', '')}_a1.csv`;
    expect(isExportFileName(`/inbox/${marked}`)).toBe(true);
    expect(parseExportFileName(marked).amazonProfileId).toBe(FIXTURE_PROFILE);
  });

  it('rejects anything it cannot attribute', () => {
    expect(isExportFileName('export.csv')).toBe(false);
    expect(isExportFileName('adlabs_target_1_2026-08-01_2026-08-07.csv')).toBe(false);
    expect(() => parseExportFileName('adlabs_profile_1_2026-08-07_2026-08-01.csv')).toThrow(
      ExportContractError,
    );
  });
});

describe('parseExport', () => {
  it('reads the profile-day grain', async () => {
    const parsed = parseExport(CLEAN_PROFILE_EXPORT, await read(INBOX_DIR, CLEAN_PROFILE_EXPORT), {
      amazonProfileId: FIXTURE_PROFILE,
    });
    expect(parsed.file.grain).toBe('profile');
    expect(parsed.profileDays).toHaveLength(7);
    expect(parsed.profileDays[0]).toEqual({
      date: '2026-08-01',
      amazonProfileId: FIXTURE_PROFILE,
      adSpend: 102,
      adSales: 396,
      totalSales: 1386,
    });
  });

  it('drops the rows for other profiles the wide export carries, and counts them', async () => {
    const parsed = parseExport(CLEAN_PROFILE_EXPORT, await read(INBOX_DIR, CLEAN_PROFILE_EXPORT), {
      amazonProfileId: FIXTURE_PROFILE,
    });
    // get_entity_data returns every profile the team can see: 10 rows in, 7 ours.
    expect(parsed.rowsParsed).toBe(10);
    expect(parsed.rowsKept).toBe(7);
    expect(parsed.profileDays.every((day) => day.amazonProfileId === FIXTURE_PROFILE)).toBe(true);
  });

  it('reads the campaign grain with quoted names', async () => {
    const parsed = parseExport(CLEAN_CAMPAIGN_EXPORT, await read(INBOX_DIR, CLEAN_CAMPAIGN_EXPORT), {
      amazonProfileId: FIXTURE_PROFILE,
    });
    expect(parsed.campaigns).toHaveLength(4);
    expect(parsed.campaigns[0]).toMatchObject({
      campaignId: 'cmp-9001',
      campaignName: 'SKW | Exact | Core',
      adSpend: 306,
      adSales: 1188,
      date: null,
    });
  });

  it('reads a semicolon, comma-decimal, BOM-prefixed export', async () => {
    const parsed = parseExport(EURO_PROFILE_EXPORT, await read(INBOX_DIR, EURO_PROFILE_EXPORT), {
      amazonProfileId: FIXTURE_OTHER_PROFILE,
    });
    expect(parsed.delimiter).toBe(';');
    expect(parsed.profileDays).toHaveLength(3);
    expect(parsed.profileDays[0]?.adSpend).toBe(102);
    expect(parsed.profileDays[0]?.adSales).toBe(396);
  });

  it('refuses an export filed against the wrong profile', async () => {
    await expect(async () =>
      parseExport(CLEAN_PROFILE_EXPORT, await read(INBOX_DIR, CLEAN_PROFILE_EXPORT), {
        amazonProfileId: FIXTURE_OTHER_PROFILE,
      }),
    ).rejects.toThrow(/names profile/);
  });

  it('names the columns it needed when they are absent', () => {
    expect(() =>
      parseExport(CLEAN_PROFILE_EXPORT, 'date,impressions\n2026-08-01,10\n', {}),
    ).toThrow(/missing required profile-grain column/);
  });

  it('refuses an unreadable date rather than guessing one', () => {
    expect(() => parseExport(CLEAN_PROFILE_EXPORT, 'date,spend,sales\nlast week,1,2\n', {})).toThrow(
      /unreadable date/,
    );
  });
});
