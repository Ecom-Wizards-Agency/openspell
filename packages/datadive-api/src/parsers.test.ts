import { describe, expect, it } from 'vitest';
import { DataDiveParseError } from './errors.js';
import { parseQuota, parseRankRadarData } from './parsers.js';
import { QUOTA, RANK_DATA } from './__fixtures__/payloads.js';

describe('DataDive response parsers', () => {
  it('rejects undocumented rank objects instead of inventing a coercion', () => {
    const payload = structuredClone(RANK_DATA) as any;
    payload.data[0].ranks[0].organicRank = { value: 19 };
    expect(() => parseRankRadarData(payload)).toThrow(DataDiveParseError);
  });

  it('rejects malformed provider dates', () => {
    const payload = structuredClone(RANK_DATA) as any;
    payload.data[0].ranks[0].date = '27-08-2026';
    expect(() => parseRankRadarData(payload)).toThrow(/yyyy-mm-dd/);
  });

  it('requires the quota feature the worker budgets against', () => {
    const payload = structuredClone(QUOTA) as any;
    delete payload.features.RANK_RADAR_KEYWORDS;
    expect(() => parseQuota(payload)).toThrow(/RANK_RADAR_KEYWORDS/);
  });
});
