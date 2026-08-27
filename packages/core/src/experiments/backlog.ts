/**
 * Vetted PPC experiment backlog and requirement-tag selector.
 *
 * Ported from the Python recommendation module's vetted backlog and selector.
 * Requirement alternatives are ORed; tags inside one alternative are ANDed.
 * A candidate with no requirements is never auto-included, and no match means
 * an empty list rather than a fabricated filler test.
 */

export interface TestCandidate {
  id?: string;
  source?: string;
  hypothesis: string;
  method?: string;
  success_metric?: string;
  priority?: string;
  requires?: string[][];
  confidence?: string;
}

export interface TestIdea {
  hypothesis: string;
  method: string;
  successMetric: string;
  source: string;
  status: 'vetted_backlog' | 'external_signal_hypothesis';
  priority: string;
}

export const DEFAULT_TEST_BACKLOG: TestCandidate[] = [
  {
    id: 'T1',
    source: 'conflicts-and-tests.md#T1',
    hypothesis:
      'Single-keyword exact-match Rank campaigns produce faster/more durable organic rank gains per dollar than equivalent broad/auto/category campaigns, despite showing worse headline ACOS.',
    method:
      'Run a matched broad-match and exact-match campaign for the same target keyword in parallel (same product, budget, period) for 4-8 weeks.',
    success_metric: 'Organic rank position delta + ACOS/CVR, both campaign types, same window.',
    priority: 'high',
    requires: [
      ['rank_present', 'goal:rank-launch'],
      ['rank_present', 'goal:scale'],
    ],
  },
  {
    id: 'T3',
    source: 'conflicts-and-tests.md#T3',
    hypothesis:
      'A permanent, very-low-bid scavenger/catch-all campaign captures incremental, low-ACOS orders without cannibalizing structured Rank/Discovery/Profit spend.',
    method: 'Run alongside (never instead of) the existing structure; track for 60 days.',
    success_metric:
      'Incremental profit contribution net of any overlap with existing broad/auto discovery campaigns.',
    priority: 'high',
    requires: [['discovery_present', 'goal:scale']],
  },
  {
    id: 'T4',
    source: 'conflicts-and-tests.md#T4',
    hypothesis:
      'Self-targeted product placement (STPP) on your own ASIN produces low-cost, incremental retargeting-like sales.',
    method: 'Set up an STPP campaign on 1-2 SKUs; compare resulting ACOS and order volume to account baseline.',
    success_metric: 'ACOS and incremental order volume vs. a matched control period/account.',
    priority: 'high',
    requires: [['profit_present'], ['shield_present']],
  },
  {
    id: 'T6',
    source: 'conflicts-and-tests.md#T6',
    hypothesis:
      'Comparing your own CTR/CVR per keyword to the SQP market/aggregate average reliably distinguishes a listing/creative problem from a genuinely winnable keyword that deserves more spend.',
    method:
      'Pull SQP for the flagged high-ACOS non-rank keywords; flag >2x CTR/CVR gaps vs. market average; act on the flagged set.',
    success_metric:
      'CTR/CVR/rank change 4-8 weeks after acting on flagged keywords, vs. an unflagged control set.',
    priority: 'high',
    requires: [['high_acos_non_rank']],
  },
  {
    id: 'T18',
    source: 'conflicts-and-tests.md#T18',
    hypothesis:
      'A formalized statistical negative-keyword threshold (e.g. 3x the clicks needed for one expected sale) produces fewer false-negative pauses than ad-hoc negation timing.',
    method:
      'Apply the threshold consistently to Discovery-category auto/broad campaigns for 60 days; audit the false-negative rate.',
    success_metric: 'ACOS improvement and negative-keyword harvest speed vs. ad-hoc review.',
    priority: 'medium',
    requires: [['discovery_bloat']],
  },
  {
    id: 'T13',
    source: 'conflicts-and-tests.md#T13',
    hypothesis:
      'Day-parting bid rules, applied only to Profit/Halo/Shield campaigns (never Rank) and only once volume/CTR/CVR fundamentals are solid, improve blended ACOS without suppressing Rank-campaign bids.',
    method:
      'Export hourly reports, build a red/white/green conditional pivot, apply bid rules only to the eligible campaign categories.',
    success_metric: 'Blended ACOS variance and conversion rate before/after; Rank-category keyword bids unchanged.',
    priority: 'medium',
    requires: [['goal:profit-maintain']],
  },
  {
    id: 'T5',
    source: 'conflicts-and-tests.md#T5',
    hypothesis:
      "Pausing own-brand Shield campaigns opens the door to competitor capture of branded search real estate within weeks.",
    method:
      'Confirmatory only -- do not actually pause Shield spend to test this. Monitor competitor impression/click share on branded terms via SQP as a standing watch.',
    success_metric: 'Competitor share-of-search on the brand term over time.',
    priority: 'high',
    requires: [
      ['goal:defend', 'shield_present'],
      ['hijacker_mentioned', 'shield_present'],
    ],
  },
];

function candidatePertinent(candidate: TestCandidate, brandTags: ReadonlySet<string>): boolean {
  const alternatives = candidate.requires ?? [];
  if (alternatives.length === 0) return false;
  return alternatives.some((alternative) => alternative.every((tag) => brandTags.has(tag)));
}

/**
 * Select pertinent vetted and external tests in input order.
 *
 * Passing `null` or `undefined` candidates uses the default backlog, matching
 * Python's optional-argument behavior. Passing an empty array deliberately
 * selects no backlog candidates.
 */
export function selectTests(
  brandTags: ReadonlySet<string>,
  candidates?: TestCandidate[] | null,
  signalItems?: TestCandidate[] | null,
): TestIdea[] {
  const out: TestIdea[] = [];
  for (const candidate of candidates ?? DEFAULT_TEST_BACKLOG) {
    if (candidatePertinent(candidate, brandTags)) {
      if (candidate.method === undefined || candidate.success_metric === undefined) {
        throw new Error('A pertinent vetted backlog candidate needs method and success_metric.');
      }
      out.push({
        hypothesis: candidate.hypothesis,
        method: candidate.method,
        successMetric: candidate.success_metric,
        source: candidate.source ?? 'conflicts-and-tests.md',
        status: 'vetted_backlog',
        priority: candidate.priority ?? 'medium',
      });
    }
  }
  for (const signal of signalItems ?? []) {
    if (candidatePertinent(signal, brandTags)) {
      out.push({
        hypothesis: signal.hypothesis,
        method: signal.method ?? 'Design a small controlled test in this account before generalizing.',
        successMetric: signal.success_metric ?? 'Define a success metric before running.',
        source: signal.source ?? 'external signal digest',
        status: 'external_signal_hypothesis',
        priority: signal.priority ?? 'low',
      });
    }
  }
  return out;
}
