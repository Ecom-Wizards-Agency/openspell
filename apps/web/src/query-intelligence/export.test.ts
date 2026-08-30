import { describe, expect, it } from 'vitest';
import type { ContextualNegativeExportArtifact } from '@wizard-ads/db';
import {
  contextualNegativeExportCsv,
  contextualNegativeExportJson,
} from './export';

function artifact(searchTerm: string): ContextualNegativeExportArtifact {
  return {
    id: '00000000-0000-4000-8000-000000000086',
    profileId: '00000000-0000-4000-8000-000000000087',
    marketplaceId: 'SYNTHETIC_MARKET',
    note: 'Synthetic export evidence.',
    rowCount: 1,
    artifactSha256: 'a'.repeat(64),
    createdBy: null,
    createdAt: new Date('2026-08-29T17:00:00.000Z'),
    items: [{
      proposalId: '00000000-0000-4000-8000-000000000088',
      ordinal: 1,
      profileId: '00000000-0000-4000-8000-000000000087',
      marketplaceId: 'SYNTHETIC_MARKET',
      campaignId: 'campaign-synthetic',
      adGroupId: 'ad-group-synthetic',
      searchTerm,
      normalizedQuery: 'synthetic query',
      category: 'excluded',
      sourceGroupRole: 'profit',
      matchType: 'negative_exact',
      reason: 'Synthetic reason.',
      decisionNote: null,
      snapshotSha256: 'b'.repeat(64),
    }],
  };
}

describe('contextual negative export rendering', () => {
  it.each([
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(1,1)',
    ' =1+1',
    '\t=1+1',
    '\u0001@SUM(1,1)',
    '\u00a0=1+1',
    '\u0085=1+1',
    '\u061c=1+1',
    '\u200b=1+1',
    '\u200c=1+1',
    '\u200d=1+1',
    '\u2028=1+1',
    '\u2060=1+1',
    '\u2066=1+1',
    '\ufeff=1+1',
  ])('neutralizes CSV formula input %j after whitespace, controls, and formatting', (value) => {
    const csv = contextualNegativeExportCsv(artifact(value));
    const dataRow = csv.split('\n')[1] ?? '';
    expect(dataRow).toContain(`'${value}`);
    expect(dataRow).not.toContain(`,${value},`);
  });

  it('preserves the authoritative text in JSON', () => {
    const value = '\t=1+1';
    const output = JSON.parse(contextualNegativeExportJson(artifact(value))) as {
      rows: { search_term: string }[];
    };
    expect(output.rows[0]?.search_term).toBe(value);
  });
});
