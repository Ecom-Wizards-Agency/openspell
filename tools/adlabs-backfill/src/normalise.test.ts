/**
 * The normalisers, against the shapes the AdLabs exports actually have.
 *
 * The fixtures here are synthetic and always will be: profile ids, campaign
 * ids and search terms are invented, because a fixture built from a live pull
 * is a client data leak with extra steps. What they reproduce faithfully is the
 * *shape* — the wide header, the zero-filled range, the missing date column
 * below profile grain, the single unwindowed `sales` — because that shape is
 * what the loaders have to survive.
 */
import { describe, expect, it } from 'vitest';
import { CsvError, parseNumber, parseProjected } from './csv.js';
import {
  measureDepth,
  monthsBetween,
  parseProfileRoster,
  parseProfileTimeline,
  profileLocalToday,
} from './timeline.js';
import { RollupParseError, adProduct, parseEntityExport } from './rollup.js';

/** A timeline export: two profiles, a zero-filled prehistory, and today. */
const TIMELINE = [
  'acos,clicks,cpc,date,impressions,orders,profile_id,sales,spend,units,seller_sales',
  '0.0,0.0,0.0,2024-12-30,0.0,0.0,9900000001,0.0,0.0,0.0,0.0',
  '0.25,12.0,0.9,2024-12-31,1500.0,2.0,9900000001,80.00,20.00,2.0,410.0',
  '0.30,10.0,1.0,2025-01-01,1200.0,1.0,9900000001,40.50,10.25,1.0,388.5',
  '0.00,0.0,0.0,2025-01-02,0.0,0.0,9900000001,0.0,0.0,0.0,0.0',
  '0.10,5.0,0.5,2025-01-03,900.0,3.0,9900000001,120.00,2.50,4.0,0.0',
  '0.40,4.0,1.2,2025-01-01,700.0,1.0,9900000002,30.00,4.80,1.0,150.0',
  '',
].join('\n');

const ROSTER = [
  'country_code,currency_code,profile_id,profile_name,state',
  'US,USD,9900000001,Fixture One,Active',
  'DE,EUR,9900000002,Fixture Two,Active',
  '',
].join('\n');

describe('the CSV reader', () => {
  it('keeps only the columns asked for', () => {
    const table = parseProjected(TIMELINE, ['date', 'spend']);
    expect(table.columns).toHaveLength(11);
    expect(Object.keys(table.rows[0] ?? {})).toEqual(['date', 'spend']);
    expect(table.rows).toHaveLength(6);
  });

  it('names the column it could not find rather than loading zeroes', () => {
    expect(() => parseProjected(TIMELINE, ['top_of_search_impression_share'])).toThrow(CsvError);
  });

  it('reads quoted fields, doubled quotes and embedded newlines', () => {
    const text = 'a,b\n"one, two","he said ""hi"""\n"line\nbreak",2\n';
    const table = parseProjected(text, ['a', 'b']);
    expect(table.rows).toEqual([
      { a: 'one, two', b: 'he said "hi"' },
      { a: 'line\nbreak', b: '2' },
    ]);
  });

  it('reads a semicolon file with comma decimals', () => {
    const text = 'date;spend\n2025-01-01;1.234,56\n';
    const table = parseProjected(text, ['date', 'spend']);
    expect(table.delimiter).toBe(';');
    expect(parseNumber(table.rows[0]?.['spend'], table.delimiter)).toBe(1234.56);
  });

  it('returns null, never zero, for a cell it cannot read', () => {
    expect(parseNumber('', ',')).toBeNull();
    expect(parseNumber('n/a', ',')).toBeNull();
    expect(parseNumber('0', ',')).toBe(0);
  });
});

describe('the profile timeline', () => {
  const parsed = parseProfileTimeline(TIMELINE);

  it('drops the zero-filled range and keeps the count', () => {
    expect(parsed.rowsSeen).toBe(6);
    expect(parsed.rowsZeroFilled).toBe(2);
    expect(parsed.byProfile.get('9900000001')).toHaveLength(3);
    expect(parsed.byProfile.get('9900000002')).toHaveLength(1);
  });

  it('maps AdLabs columns onto the fact grain, oldest first', () => {
    expect(parsed.byProfile.get('9900000001')?.[0]).toEqual({
      amazonProfileId: '9900000001',
      date: '2024-12-31',
      impressions: 1500,
      clicks: 12,
      cost: 20,
      purchases7d: 2,
      sales7d: 80,
      unitsSold7d: 2,
    });
  });

  it('measures depth in months back from a reference day', () => {
    const depths = measureDepth(parsed, '2025-07-15');
    expect(depths[0]?.amazonProfileId).toBe('9900000001');
    expect(depths[0]?.monthsBack).toBe(6);
    expect(depths[0]?.daysWithData).toBe(3);
    expect(depths[0]?.firstDate).toBe('2024-12-31');
  });

  it('counts whole months only', () => {
    expect(monthsBetween('2024-08-15', '2026-08-14')).toBe(23);
    expect(monthsBetween('2024-08-14', '2026-08-14')).toBe(24);
  });

  it('reads currency off the roster and never reads the profile name', () => {
    expect(parseProfileRoster(ROSTER)).toEqual(
      new Map([
        ['9900000001', 'USD'],
        ['9900000002', 'EUR'],
      ]),
    );
  });

  it('answers "what day is it" in the profile timezone, not the machine one', () => {
    // 2026-08-14T02:00Z is still the 13th in Los Angeles and already the 14th
    // in Berlin: the in-progress day is a per-profile question.
    const instant = new Date('2026-08-14T02:00:00Z');
    expect(profileLocalToday('America/Los_Angeles', instant)).toBe('2026-08-13');
    expect(profileLocalToday('Europe/Berlin', instant)).toBe('2026-08-14');
    expect(() => profileLocalToday('Middle/Earth', instant)).toThrow(/timezone/);
  });
});

/** A campaign export: no date column, one idle row, two rows to merge. */
const CAMPAIGNS = [
  'campaign_ad_type,campaign_id,campaign_name,clicks,impressions,orders,sales,spend,units',
  'Sponsored Products,cmp-1,"SKW | Exact",10,1000,2,80.00,12.50,2',
  'Sponsored Products,cmp-1,"SKW | Exact",5,500,1,20.00,7.50,1',
  'Sponsored Brands,cmp-2,"SB | Video",4,400,0,0.00,4.25,0',
  'Sponsored Display,cmp-3,"SD | Retarget",0,0,0,0.00,0.00,0',
  '',
].join('\n');

describe('the monthly rollup normaliser', () => {
  const parsed = parseEntityExport('campaign', CAMPAIGNS);

  it('drops idle rows, merges duplicate dimensions, and counts both', () => {
    expect(parsed.rowsSeen).toBe(4);
    expect(parsed.rowsIdle).toBe(1);
    expect(parsed.rowsMerged).toBe(1);
    expect(parsed.rows).toHaveLength(2);
  });

  it('sums merged rows rather than letting one win the primary key', () => {
    const first = parsed.rows[0];
    expect(first?.dimensions).toEqual({
      grain: 'campaign',
      campaign_id: 'cmp-1',
      ad_product: 'SP',
    });
    expect(first?.cost).toBe(20);
    expect(first?.sales7d).toBe(100);
    expect(first?.clicks).toBe(15);
  });

  it('totals the file to the cent', () => {
    expect(parsed.totals.cost).toBe(24.25);
    expect(parsed.totals.sales7d).toBe(100);
    expect(parsed.totals.impressions).toBe(1900);
  });

  it('keys target and search-term grains on the ids the daily tables use', () => {
    const targets = parseEntityExport(
      'target',
      [
        'ad_group_id,campaign_ad_type,campaign_id,clicks,impressions,orders,sales,spend,target_id,units',
        'agp-1,Sponsored Products,cmp-1,3,300,1,25.00,3.10,tgt-1,1',
        '',
      ].join('\n'),
    );
    expect(targets.rows[0]?.dimensions).toEqual({
      grain: 'target',
      campaign_id: 'cmp-1',
      ad_group_id: 'agp-1',
      target_id: 'tgt-1',
      ad_product: 'SP',
    });

    const placements = parseEntityExport(
      'placement',
      [
        'campaign_ad_type,campaign_id,clicks,impressions,orders,placement_type_raw,sales,spend,units',
        'Sponsored Products,cmp-1,3,300,1,SITE_AMAZON_BUSINESS,25.00,3.10,1',
        '',
      ].join('\n'),
    );
    // Kept raw: the Amazon Business rows are in the file and out of AdLabs'
    // own aggregate, and renaming the label would hide that.
    expect(placements.rows[0]?.dimensions['placement']).toBe('SITE_AMAZON_BUSINESS');
  });

  it('refuses a row with no campaign id instead of keying a rollup on nothing', () => {
    expect(() =>
      parseEntityExport(
        'campaign',
        ['campaign_ad_type,campaign_id,clicks,impressions,orders,sales,spend,units',
         'Sponsored Products,,1,1,0,0,1.00,0', ''].join('\n'),
      ),
    ).toThrow(RollupParseError);
  });

  it('maps the provider ad-type labels onto ours', () => {
    expect(adProduct('Sponsored Products')).toBe('SP');
    expect(adProduct('Sponsored Brands')).toBe('SB');
    expect(adProduct('Sponsored Display')).toBe('SD');
    expect(adProduct('')).toBe('unknown');
  });
});
