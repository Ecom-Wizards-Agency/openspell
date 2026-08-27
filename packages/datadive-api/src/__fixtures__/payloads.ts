export const RADAR_ONE = {
  id: 'radar-synthetic-1',
  asin: { id: 'asin-row-1', krtId: 'krt-synthetic-1', asin: 'B000SYNTH01' },
  marketplace: 'US',
  keywordCount: 2,
  title: 'Synthetic desk lamp',
  imageUrl: 'https://images.invalid/synthetic-lamp.jpg',
  top10KW: { current: 1 },
  top10SV: { current: 120 },
  top50KW: { current: 2 },
  top50SV: { current: 280 },
};

export const RADAR_TWO = {
  id: 'radar-synthetic-2',
  asin: { id: 'asin-row-2', krtId: 'krt-synthetic-2', asin: 'B000SYNTH02' },
  marketplace: 'US',
  keywordCount: 1,
  title: 'Synthetic floor lamp',
  imageUrl: 'https://images.invalid/synthetic-floor-lamp.jpg',
  top10KW: { current: 0 },
  top10SV: { current: 0 },
  top50KW: { current: 1 },
  top50SV: { current: 90 },
};

export const RANK_DATA = {
  data: [
    {
      id: 'keyword-synthetic-1',
      keyword: 'adjustable reading lamp',
      searchVolume: 120,
      ranks: [
        { date: '2026-08-26', organicRank: 19, impressionRank: 4 },
        { date: '2026-08-27', organicRank: 14, impressionRank: 3 },
      ],
      highlights: [],
    },
    {
      id: 'keyword-synthetic-2',
      keyword: 'compact task light',
      searchVolume: null,
      ranks: [{ date: '2026-08-27', organicRank: null, impressionRank: null }],
      highlights: [{ date: '2026-08-27', note: 'synthetic fixture' }],
    },
  ],
};

export const QUOTA = {
  nextRefreshDate: '2026-09-01T00:00:00.000Z',
  features: {
    DIVED_ASINS: { used: 12, capacity: 100 },
    RANK_RADAR_KEYWORDS: { used: 3, capacity: 500 },
    PRODUCT_BRIEF_ASINS: { used: 2, capacity: 50 },
    AI_COPYWRITER_PROMPTS: { used: 4, capacity: 100 },
    INDEXING_DIAGNOSIS: { used: 1, capacity: 100 },
  },
};
