import { describe, expect, it } from 'vitest';
import { profileTestTags } from './data.js';
import { selectTests } from '@wizard-ads/core';

describe('experiment proposed-test signals', () => {
  it('maps the profile goal and campaign categories to backlog tags', () => {
    const tags = profileTestTags({
      goal: 'scale',
      campaignNames: [
        'Rank | SP | Exact | synthetic',
        'Discovery | SP | Auto | synthetic',
        'Profit | SP | Exact | synthetic',
      ],
    });
    expect([...tags].sort()).toEqual([
      'discovery_present',
      'goal:scale',
      'profit_present',
      'rank_present',
    ]);
    expect(selectTests(tags).map((test) => test.source)).toEqual([
      'conflicts-and-tests.md#T1',
      'conflicts-and-tests.md#T3',
      'conflicts-and-tests.md#T4',
    ]);
  });

  it('returns no filler proposal when the profile signals match nothing', () => {
    const tags = profileTestTags({ goal: null, campaignNames: ['Unclassified campaign'] });
    expect(selectTests(tags)).toEqual([]);
  });
});
