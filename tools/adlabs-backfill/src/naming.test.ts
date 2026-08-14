/**
 * The two file contracts cannot collide.
 *
 * The crosscheck ingests anything in its inbox matching
 * `adlabs_<grain>_<profileId>_<start>_<end>[_marker].csv`. A backfill file
 * named `adlabs_campaign_…_bf.csv` would match — `bf` reads as the optional
 * marker — and would be compared against our own facts as though somebody had
 * just exported it from the incumbent. That is the crosscheck poisoning again,
 * arriving through the filesystem instead of the database.
 *
 * So this suite asserts the negative over every name the backfill can produce,
 * not over a hand-picked example: the crosscheck's own `isExportFileName` is
 * imported and must reject all of them. If either regex is ever loosened, this
 * fails, which is the point of testing across the boundary rather than
 * restating one side's pattern.
 */
import { describe, expect, it } from 'vitest';
import { isExportFileName } from '@wizard-ads/crosscheck-cli/pure';
import {
  ALL_PROFILES,
  BACKFILL_GRAINS,
  BackfillNameError,
  backfillFileName,
  backfillFilePath,
  isBackfillFileName,
  parseBackfillFileName,
} from './naming.js';

const SCOPES = [ALL_PROFILES, '1234567890123456', '9900000001'];
const WINDOWS: [string, string][] = [
  ['2024-01-01', '2024-01-31'],
  ['2026-08-13', '2026-08-13'],
  ['2018-01-01', '2026-08-14'],
];

describe('the backfill naming contract', () => {
  it('produces nothing the crosscheck inbox will ingest', () => {
    for (const grain of BACKFILL_GRAINS) {
      for (const scope of SCOPES) {
        for (const [start, end] of WINDOWS) {
          const name = backfillFileName(grain, scope, start, end);
          expect(isBackfillFileName(name)).toBe(true);
          expect(isExportFileName(name), `${name} must not match the crosscheck inbox`).toBe(false);
        }
      }
    }
  });

  it('rejects the near-miss the prefix exists to prevent', () => {
    // The name somebody would reach for without this contract.
    const tempting = 'adlabs_campaign_9900000001_2024-01-01_2024-01-31_bf.csv';
    expect(isExportFileName(tempting)).toBe(true);
    expect(isBackfillFileName(tempting)).toBe(false);
  });

  it('round-trips grain, scope and window', () => {
    const name = backfillFileName('target', '9900000001', '2024-03-01', '2024-03-31');
    expect(parseBackfillFileName(name)).toEqual({
      grain: 'target',
      scope: '9900000001',
      startDate: '2024-03-01',
      endDate: '2024-03-31',
    });
  });

  it('files a pull under its scope and grain', () => {
    expect(
      backfillFilePath('_local/backfill', {
        grain: 'search_term',
        scope: '9900000001',
        startDate: '2024-03-01',
        endDate: '2024-03-31',
      }),
    ).toBe(
      '_local/backfill/9900000001/search_term/adlabsbf_search_term_9900000001_2024-03-01_2024-03-31.csv',
    );
  });

  it('refuses a backwards window and a scope that is not an id', () => {
    expect(() => backfillFileName('profile', 'all', '2024-02-01', '2024-01-01')).toThrow(
      BackfillNameError,
    );
    expect(() => backfillFileName('profile', 'Client Name', '2024-01-01', '2024-02-01')).toThrow(
      BackfillNameError,
    );
  });

  it('refuses to parse a name from the other contract', () => {
    expect(() =>
      parseBackfillFileName('adlabs_profile_9900000001_2024-01-01_2024-01-31.csv'),
    ).toThrow(BackfillNameError);
  });
});
