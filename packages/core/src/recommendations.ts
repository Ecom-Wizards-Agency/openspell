/**
 * Port of `recommendations.py`: the weekly proposal engine.
 *
 * Three read-only decision lists over one account's week: PUSH (worth
 * scaling), PAUSE / OPTIMIZE (bleeders and bloat), and TEST (only when the
 * week's own signals make a backlog item pertinent, never fabricated to fill
 * space), plus GRADUATE for rank keywords that have done their job.
 *
 * The rule that shapes everything: a Rank/SKW target is never proposed for a
 * cut on ACOS grounds alone. ACOS is an indicator, not a decision factor, for a
 * keyword deliberately run at or above break-even to buy organic rank. Where
 * the engine declines to cut, it says so in `notes` rather than staying silent,
 * because an unexplained omission reads as a clean bill of health.
 *
 * This module proposes. It never executes.
 */
import { classifyCampaignCategory } from './classify.js';
import { selectTests, type TestCandidate, type TestIdea } from './experiments/backlog.js';
import { DEFAULT_THRESHOLDS, resolveGoalLens } from './flags.js';
import { formatFixed, formatMoney } from './num.js';
import type { PacingResult } from './pacing.js';
import {
  CATEGORY_DISCOVERY,
  CATEGORY_PROFIT,
  CATEGORY_RANK,
  CATEGORY_SHIELD,
  CATEGORY_UNKNOWN,
  type CampaignCategory,
} from './types.js';

export interface RecThresholds {
  /** Weekly impressions floor for a Rank target to count as losing visibility. */
  near_zero_impressions_weekly: number;
  /** Weekly spend with zero orders that makes a non-Rank target a negative candidate. */
  zero_sale_spend_min_weekly: number;
  /** Spend below this fraction of (daily budget x 7) counts as headroom. */
  budget_headroom_max_utilization: number;
  non_rank_acos_ceiling: number;
  profitable_push_acos_ceiling: number;
  discovery_cvr_push_floor: number;
  stalled_spend_max: number;
  stalled_impressions_max: number;
  graduate_rank_max: number;
  graduate_weeks_stable: number;
}

export const DEFAULT_REC_THRESHOLDS: RecThresholds = {
  near_zero_impressions_weekly: 100,
  zero_sale_spend_min_weekly: 15.0,
  budget_headroom_max_utilization: 0.7,
  non_rank_acos_ceiling: 0.35,
  profitable_push_acos_ceiling: 0.2,
  discovery_cvr_push_floor: 0.03,
  stalled_spend_max: 1.0,
  stalled_impressions_max: 20,
  graduate_rank_max: 3,
  graduate_weeks_stable: 2,
};

/**
 * Non-rank ACOS ceiling per goal. `null` for liquidate: margin erosion is
 * expected there, so the ceiling check is skipped entirely rather than
 * loosened to a number that would still fire.
 */
const NON_RANK_ACOS_CEILING_BY_GOAL: Record<string, number | null> = {
  'rank-launch': 0.45,
  scale: 0.35,
  'profit-maintain': 0.25,
  defend: 0.4,
  liquidate: null,
  maintain: 0.35,
  neutral: 0.35,
};

export interface RecConfig {
  rec_thresholds?: Partial<RecThresholds>;
}

export function resolveRecThresholds(config?: RecConfig | null): RecThresholds {
  const merged: RecThresholds = { ...DEFAULT_REC_THRESHOLDS };
  const known = Object.keys(DEFAULT_REC_THRESHOLDS) as Array<keyof RecThresholds>;
  if (config?.rec_thresholds) {
    for (const key of known) {
      const value = config.rec_thresholds[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function nonRankAcosCeiling(goal: string | null | undefined, thresholds: RecThresholds): number | null {
  if (goal !== null && goal !== undefined && goal in NON_RANK_ACOS_CEILING_BY_GOAL) {
    return NON_RANK_ACOS_CEILING_BY_GOAL[goal] as number | null;
  }
  return thresholds.non_rank_acos_ceiling;
}

function discoveryShareMax(goal: string | null | undefined): number {
  const lens = resolveGoalLens(goal);
  return lens.threshold_overrides.discovery_share_max ?? DEFAULT_THRESHOLDS.discovery_share_max;
}

// ---------------------------------------------------------------------------
// Entity normalization.

/** One weekly campaign/target row as the caller supplies it. */
export interface RawEntity {
  entity_type?: string | null;
  name?: string | null;
  campaign_name?: string | null;
  campaign_id?: string | null;
  category?: CampaignCategory | null;
  match_type?: string | null;
  impressions?: number | null;
  clicks?: number | null;
  spend?: number | null;
  sales?: number | null;
  orders?: number | null;
  daily_budget?: number | null;
  budget_capped_days?: number | null;
}

export interface Entity {
  entityType: string;
  name: string;
  campaignName: string;
  campaignId: string | null;
  category: CampaignCategory;
  matchType: string | null;
  impressions: number;
  clicks: number;
  spend: number;
  sales: number;
  orders: number;
  dailyBudget: number | null;
  budgetCappedDays: number;
  raw: RawEntity;
}

/** `spend / sales`; with no sales, `null` at zero spend and infinite otherwise. */
export function entityAcos(e: Entity): number | null {
  if (e.sales) return e.spend / e.sales;
  return e.spend === 0 ? null : Number.POSITIVE_INFINITY;
}

export function entityCvr(e: Entity): number | null {
  return e.clicks ? e.orders / e.clicks : null;
}

export function entityWeekBudget(e: Entity): number | null {
  return e.dailyBudget ? e.dailyBudget * 7 : null;
}

/**
 * Headroom deliberately reads the module default rather than the merged
 * thresholds, exactly as the reference does. Changing it here would silently
 * diverge from the Python behaviour the goldens capture.
 */
export function entityHasHeadroom(e: Entity): boolean {
  const wb = entityWeekBudget(e);
  if (!wb) return false;
  return e.spend < DEFAULT_REC_THRESHOLDS.budget_headroom_max_utilization * wb;
}

function dedupeKey(e: Entity): string {
  return `${(e.name || '').trim().toLowerCase()}\u0000${(e.matchType || '').trim().toLowerCase()}`;
}

function toInt(value: number | null | undefined): number {
  return Math.trunc(value || 0);
}

/** `category` falls back to the campaign-name classifier when absent or Unknown. */
export function normalizeEntities(rawEntities: RawEntity[]): Entity[] {
  return rawEntities.map((r) => {
    const campaignName = r.campaign_name || r.name || '';
    let category = r.category || CATEGORY_UNKNOWN;
    if (category === CATEGORY_UNKNOWN) category = classifyCampaignCategory(campaignName);
    return {
      entityType: r.entity_type ?? 'target',
      name: r.name || campaignName,
      campaignName,
      campaignId: r.campaign_id ?? null,
      category,
      matchType: r.match_type ?? null,
      impressions: toInt(r.impressions),
      clicks: toInt(r.clicks),
      spend: Number(r.spend || 0.0),
      sales: Number(r.sales || 0.0),
      orders: toInt(r.orders),
      dailyBudget: r.daily_budget ?? null,
      budgetCappedDays: toInt(r.budget_capped_days),
      raw: r,
    };
  });
}

// ---------------------------------------------------------------------------
// Output shapes.

export interface PushItem {
  entity: string;
  scope: string;
  category: CampaignCategory;
  why: string;
  action: string;
  expectedImpact: string;
}

export interface PauseOptimizeItem {
  entity: string;
  scope: string;
  category: CampaignCategory;
  why: string;
  action: string;
}

/** A Rank keyword that has done its job: step it down, never cliff-drop it. */
export interface GraduateItem {
  keyword: string;
  rankNow: number;
  weeksStable: number;
  why: string;
  action: string;
}

export interface RecommendationsResult {
  push: PushItem[];
  pauseOptimize: PauseOptimizeItem[];
  tests: TestIdea[];
  /** Data-quality and no-fabrication notes, including every declined cut. */
  notes: string[];
  graduate: GraduateItem[];
}

// ---------------------------------------------------------------------------
// Rank Radar rows: the live organic-rank signal that turns "never cut Rank on
// ACOS alone" from a category rule into a per-keyword, data-backed protection.

export interface RawRadarRow {
  keyword?: string | null;
  rank_now?: number | null;
  rank_prev?: number | null;
  weeks_stable?: number | null;
}

export interface RadarRow {
  keyword: string;
  rankNow: number;
  rankPrev: number | null;
  weeksStable: number;
}

/** Rows without a keyword or a numeric current rank are skipped, not defaulted. */
export function normalizeRankRadar(rows: RawRadarRow[] | null | undefined): Map<string, RadarRow> {
  const out = new Map<string, RadarRow>();
  for (const r of rows ?? []) {
    const keyword = (r.keyword || '').trim().toLowerCase();
    const rankNow = r.rank_now;
    if (!keyword || typeof rankNow !== 'number' || Number.isNaN(rankNow)) continue;
    const rankPrev = typeof r.rank_prev === 'number' && !Number.isNaN(r.rank_prev) ? Math.trunc(r.rank_prev) : null;
    out.set(keyword, {
      keyword: (r.keyword as string).trim(),
      rankNow: Math.trunc(rankNow),
      rankPrev,
      weeksStable: toInt(r.weeks_stable),
    });
  }
  return out;
}

function radarFor(radar: Map<string, RadarRow>, name: string | null | undefined): RadarRow | null {
  if (radar.size === 0 || !name) return null;
  return radar.get(name.trim().toLowerCase()) ?? null;
}

function rankImproving(row: RadarRow): boolean {
  return row.rankPrev !== null && row.rankNow < row.rankPrev;
}

function graduates(row: RadarRow, thresholds: RecThresholds): boolean {
  return row.rankNow <= thresholds.graduate_rank_max && row.weeksStable >= thresholds.graduate_weeks_stable;
}

function generateGraduate(radar: Map<string, RadarRow>, thresholds: RecThresholds): GraduateItem[] {
  const items: GraduateItem[] = [];
  for (const row of radar.values()) {
    if (!graduates(row, thresholds)) continue;
    items.push({
      keyword: row.keyword,
      rankNow: row.rankNow,
      weeksStable: row.weeksStable,
      why:
        `Organic rank ${row.rankNow} for ${row.weeksStable} consecutive Rank Radar weeks ` +
        '-- the rank push has done its job; stop paying above break-even here.',
      action:
        'Step the ToS placement modifier and bid down toward break-even over 2-3 optimizer ' +
        'cycles (never cliff-drop -- deranking follows cliff-drops); the keyword moves to the ' +
        'Profit role. Re-escalation if rank later slips past 5 is an operator decision.',
    });
  }
  items.sort((a, b) => (a.rankNow !== b.rankNow ? a.rankNow - b.rankNow : a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// PUSH.

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'n/a';
  if (v === Number.POSITIVE_INFINITY) return 'inf';
  return `${formatFixed(v * 100, 0)}%`;
}

function pushForEntity(
  e: Entity,
  thresholds: RecThresholds,
  radar: Map<string, RadarRow>,
): PushItem | null {
  const radarRow = radarFor(radar, e.name);
  // Rank achieved: the GRADUATE list carries this keyword, so do not also
  // propose pushing it harder.
  if (radarRow && graduates(radarRow, thresholds)) return null;

  if (e.category === CATEGORY_RANK) {
    if (e.impressions <= thresholds.near_zero_impressions_weekly) {
      return {
        entity: e.name,
        scope: e.campaignName,
        category: e.category,
        why:
          `Rank/SKW target collapsed to ${formatFixed(e.impressions, 0, true)} impressions this week -- losing ` +
          "visibility on the exact keyword we're trying to rank is the single worst outcome " +
          'under the rank-first philosophy.',
        action:
          "Raise the bid (and lift the ToS/placement modifier if capped) to regain impression share; verify the listing isn't suppressed/out of stock first.",
        expectedImpact: 'Restore impression share and resume rank progress on this keyword.',
      };
    }
    if (e.budgetCappedDays >= 1) {
      return {
        entity: e.name,
        scope: e.campaignName,
        category: e.category,
        why: `Budget-capped ${e.budgetCappedDays} of 7 days this week on a Rank/SKW target -- capping loses impression share on the keyword we're trying to rank.`,
        action: e.dailyBudget
          ? `Raise the daily budget (currently ${formatMoney(e.dailyBudget)}/day).`
          : 'Raise the daily budget.',
        expectedImpact: 'More consistent impression share across the full day; faster rank progress.',
      };
    }
    if (e.orders > 0) {
      // Converting Rank keyword with room to keep pushing: ACOS is not a
      // decision factor here even when it is high, because that is the plan.
      if (entityHasHeadroom(e) || !entityWeekBudget(e)) {
        return {
          entity: e.name,
          scope: e.campaignName,
          category: e.category,
          why:
            `Rank/SKW target converting (${e.orders} order(s) this week, ACOS ` +
            `${fmtPct(entityAcos(e))}) with budget headroom -- ACOS is an indicator, not a ` +
            "decision factor, for a keyword we're deliberately running at/above break-even to drive rank.",
          action: 'Raise the bid modestly and/or lift the top-of-search placement modifier to accelerate rank.',
          expectedImpact: 'Faster organic rank movement on this keyword.',
        };
      }
    }
    return null;
  }

  if (e.category === CATEGORY_SHIELD) {
    if (e.budgetCappedDays >= 1 || e.impressions <= thresholds.near_zero_impressions_weekly) {
      return {
        entity: e.name,
        scope: e.campaignName,
        category: e.category,
        why: 'Brand-defense target is budget-capped or impressions collapsed -- ceding branded search real estate to a competitor/hijacker is the real risk here.',
        action: 'Raise bid/budget to protect the brand term; confirm no listing/inventory issue is the real cause first.',
        expectedImpact: "Hold Amazon's Choice / top-of-search on the brand term.",
      };
    }
    return null;
  }

  if (e.category === CATEGORY_PROFIT) {
    const acos = entityAcos(e);
    if (e.orders > 0 && acos !== null && acos <= thresholds.profitable_push_acos_ceiling) {
      return {
        entity: e.name,
        scope: e.campaignName,
        category: e.category,
        why: `Profit/Halo target converting at a clearly profitable ACOS (${fmtPct(acos)}, ${e.orders} order(s) this week).`,
        action:
          'Raise bid and/or budget to capture more of this low-ACOS demand.' +
          (e.budgetCappedDays >= 1 ? ' Currently budget-capped -- raise the daily budget first.' : ''),
        expectedImpact: 'Incremental profit at low risk.',
      };
    }
    return null;
  }

  if (e.category === CATEGORY_DISCOVERY) {
    const cvr = entityCvr(e);
    if (e.orders > 0 && cvr !== null && cvr >= thresholds.discovery_cvr_push_floor && !e.budgetCappedDays) {
      return {
        entity: e.name,
        scope: e.campaignName,
        category: e.category,
        why: `Discovery target converting well (CVR ${fmtPct(cvr)}, ${e.orders} order(s) this week) -- a candidate to graduate into an exact/Rank campaign, or a modest bid raise in place.`,
        action:
          "Raise the bid slightly and/or harvest the converting search term into its own exact/Profit campaign; watch the account's overall discovery share stays near the ~20% cap.",
        expectedImpact: 'Captures more of a proven-converting term without growing discovery bloat.',
      };
    }
    return null;
  }

  return null;
}

function generatePush(
  entities: Entity[],
  thresholds: RecThresholds,
  radar: Map<string, RadarRow>,
): PushItem[] {
  const items: PushItem[] = [];
  for (const e of entities) {
    const item = pushForEntity(e, thresholds, radar);
    if (item !== null) items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// PAUSE / OPTIMIZE.

function discoveryShareOfSpend(entities: Entity[]): number | null {
  const total = entities.reduce((sum, e) => sum + e.spend, 0);
  if (total <= 0) return null;
  const discovery = entities
    .filter((e) => e.category === CATEGORY_DISCOVERY)
    .reduce((sum, e) => sum + e.spend, 0);
  return discovery / total;
}

/**
 * Group targets by (name, match type) across DISTINCT campaigns: the same
 * keyword bidding against itself in more than one campaign.
 */
function selfCompetitionGroups(entities: Entity[]): Map<string, Entity[]> {
  const byKey = new Map<string, Entity[]>();
  for (const e of entities) {
    if (!e.name || e.entityType === 'campaign') continue;
    const key = dedupeKey(e);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(e);
    else byKey.set(key, [e]);
  }
  const out = new Map<string, Entity[]>();
  for (const [key, group] of byKey) {
    const ids = new Set(group.filter((e) => e.campaignId).map((e) => e.campaignId as string));
    if (ids.size > 1) out.set(key, group);
  }
  return out;
}

interface CampaignTotals {
  name: string;
  spend: number;
  impressions: number;
  category: CampaignCategory;
}

/** Roll target rows up to campaign totals; rows already at campaign grain win. */
function campaignTotals(entities: Entity[]): Map<string, CampaignTotals> {
  const totals = new Map<string, CampaignTotals>();
  for (const e of entities) {
    const key = e.campaignId || e.campaignName;
    let agg = totals.get(key);
    if (!agg) {
      agg = { name: e.campaignName, spend: 0.0, impressions: 0, category: e.category };
      totals.set(key, agg);
    }
    if (e.entityType === 'campaign') {
      agg.spend = e.spend;
      agg.impressions = e.impressions;
    } else {
      agg.spend += e.spend;
      agg.impressions += e.impressions;
    }
  }
  return totals;
}

interface PauseOptimizeOutput {
  items: PauseOptimizeItem[];
  notes: string[];
  tags: Set<string>;
}

function generatePauseOptimize(
  entities: Entity[],
  goal: string | null | undefined,
  thresholds: RecThresholds,
  radar: Map<string, RadarRow>,
): PauseOptimizeOutput {
  const items: PauseOptimizeItem[] = [];
  const notes: string[] = [];
  const tags = new Set<string>();
  const ceiling = nonRankAcosCeiling(goal, thresholds);

  const rankProtected = (e: Entity): string | null => {
    const row = radarFor(radar, e.name);
    if (row && rankImproving(row)) {
      return (
        `organic rank improving (${row.rankPrev} -> ${row.rankNow} per Rank Radar) -- ` +
        "we're buying position; don't cut on ACOS alone"
      );
    }
    return null;
  };

  for (const e of entities) {
    // Campaign-level rollups are handled by the stalled-campaign check below.
    if (e.entityType === 'campaign') continue;

    let actioned = false;

    // 1. Zero-sale high spend: a negative-keyword/target candidate.
    if (e.spend >= thresholds.zero_sale_spend_min_weekly && e.orders === 0) {
      const protection = rankProtected(e);
      if (e.category === CATEGORY_RANK) {
        const extra = protection ? ` Rank Radar backs this up: ${protection}.` : '';
        notes.push(
          `'${e.name}' (Rank/SKW, ${e.campaignName}): ${formatMoney(e.spend)} spend with 0 orders this ` +
            'week -- NOT proposed for a cut. Rank/SKW targets may intentionally run at break-even ' +
            'or a loss to drive rank (strategy.md); verify this is the plan before touching it.' +
            extra,
        );
      } else if (protection) {
        notes.push(
          `'${e.name}' (${e.category}, ${e.campaignName}): ${formatMoney(e.spend)} spend with 0 orders this ` +
            `week -- NOT proposed for a cut: ${protection}.`,
        );
      } else {
        items.push({
          entity: e.name,
          scope: e.campaignName,
          category: e.category,
          why: `${formatMoney(e.spend)} spend with 0 orders this week, non-rank target -- negative-keyword/target candidate.`,
          action: "Add as a negative exact (or pause the target) unless there's a known reason to keep testing it.",
        });
        // Already actioned: do not also run the ACOS-ceiling check on it.
        actioned = true;
      }
    }
    if (actioned) continue;

    // 2. High-ACOS non-rank target: converting, but inefficient.
    const acos = entityAcos(e);
    if (e.category !== CATEGORY_RANK && ceiling !== null && e.orders > 0 && acos !== null && acos > ceiling) {
      const protection = rankProtected(e);
      if (protection) {
        notes.push(
          `'${e.name}' (${e.category}, ${e.campaignName}): ACOS ${fmtPct(acos)} over the ` +
            `~${fmtPct(ceiling)} ceiling -- NOT proposed for a cut: ${protection}.`,
        );
      } else {
        items.push({
          entity: e.name,
          scope: e.campaignName,
          category: e.category,
          why: `ACOS ${fmtPct(acos)} vs the ~${fmtPct(ceiling)} ceiling for a ${e.category} target under this goal, despite converting.`,
          action: "Lower the bid, tighten match type, or reallocate budget toward the account's Rank/Profit campaigns.",
        });
        tags.add('high_acos_non_rank');
      }
    }
  }

  // 3. Discovery share of spend creeping past the goal-aware cap.
  const share = discoveryShareOfSpend(entities);
  const cap = discoveryShareMax(goal);
  if (share !== null && share > cap) {
    items.push({
      entity: 'Discovery campaigns (account-wide)',
      scope: 'account',
      category: CATEGORY_DISCOVERY,
      why: `Discovery is ${fmtPct(share)} of this week's spend (target ~${fmtPct(cap)} or less per the ~80/20 exact/discovery split).`,
      action: 'Tighten Discovery bids and search-term hygiene; reallocate the freed budget toward Rank/exact campaigns.',
    });
    tags.add('discovery_bloat');
  }

  // 4. Self-competition: same target and match type across distinct campaigns.
  for (const [key, group] of selfCompetitionGroups(entities)) {
    const [name, matchType] = key.split('\u0000') as [string, string];
    // Keep the strongest performer (most orders, then lowest ACOS) unflagged;
    // the rest are the consolidation candidates.
    const ranked = [...group].sort((a, b) => {
      if (a.orders !== b.orders) return b.orders - a.orders;
      const aAcos = entityAcos(a) ?? Number.POSITIVE_INFINITY;
      const bAcos = entityAcos(b) ?? Number.POSITIVE_INFINITY;
      return aAcos - bAcos;
    });
    const keep = ranked[0] as Entity;
    const rest = ranked.slice(1);
    const campaigns = [...new Set(group.map((e) => e.campaignName))].sort().join(', ');
    const restCampaigns = [...new Set(rest.map((e) => e.campaignName))].sort().join(', ');
    const distinctCampaignIds = new Set(group.map((e) => e.campaignId)).size;
    items.push({
      entity: `${name} (${matchType || 'match type n/a'})`,
      scope: campaigns,
      category: keep.category,
      why: `Same target running in ${distinctCampaignIds} campaigns (${campaigns}) -- self-competition, bidding against itself in the auction.`,
      action: `Consolidate into '${keep.campaignName}' (best performer: ${keep.orders} order(s), ACOS ${fmtPct(entityAcos(keep))}); pause/remove the duplicate(s) in ${restCampaigns}.`,
    });
    tags.add('self_competition');
  }

  // 5. Redundant / stalled campaigns: near-zero spend and impressions.
  for (const agg of campaignTotals(entities).values()) {
    if (agg.spend <= thresholds.stalled_spend_max && agg.impressions <= thresholds.stalled_impressions_max) {
      items.push({
        entity: agg.name,
        scope: agg.name,
        category: agg.category,
        why: `Near-zero activity this week (${formatMoney(agg.spend)} spend, ${formatFixed(agg.impressions, 0, true)} impressions) -- stalled/redundant.`,
        action: "Investigate (suppressed listing, exhausted keyword, mis-targeted) and archive if there's no path back to relevance.",
      });
      tags.add('stalled_campaign');
    }
  }

  return { items, notes, tags };
}

// ---------------------------------------------------------------------------
// Signal digest parsing. Convention:
//
//   - **Claim text.** Tags: tag1, tag2. Source: <name/url>. Confidence: unverified.
//
// A bullet that does not match is skipped rather than raising: a freeform
// digest yields zero items, it does not break the weekly run.

const DIGEST_BULLET_RE =
  /^\s*-\s*\*\*(.+?)\*\*\.?\s*Tags:\s*([^.]*)\.\s*Source:\s*([^.]*)\.\s*Confidence:\s*([\w-]+)\.?\s*$/;

export function parseSignalDigestMarkdown(text: string | null | undefined): TestCandidate[] {
  if (!text) return [];
  const items: TestCandidate[] = [];
  for (const line of text.split('\n')) {
    const m = DIGEST_BULLET_RE.exec(line);
    if (!m) continue;
    const tags = (m[2] as string)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    items.push({
      hypothesis: (m[1] as string).trim().replace(/\.+$/, '').trim(),
      success_metric: "Define a success metric mapped to this brand's goal before running.",
      source: (m[3] as string).trim(),
      confidence: (m[4] as string).trim().toLowerCase(),
      requires: tags.length > 0 ? [tags] : [],
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Brand tags and the top-level entry point.

const SITUATION_KEYWORD_TAGS: Array<[string, string]> = [
  ['hijack', 'hijacker_mentioned'],
  ['crisis', 'crisis_mentioned'],
  ['acos spike', 'acos_spike_mentioned'],
  ['recurring acos', 'acos_spike_mentioned'],
];

function situationTags(situation: string | null | undefined): Set<string> {
  if (!situation) return new Set();
  const low = situation.toLowerCase();
  const out = new Set<string>();
  for (const [keyword, tag] of SITUATION_KEYWORD_TAGS) {
    if (low.includes(keyword)) out.add(tag);
  }
  return out;
}

function computeBrandTags(
  entities: Entity[],
  goal: string | null | undefined,
  situation: string | null | undefined,
  pauseTags: Set<string>,
): Set<string> {
  const tags = new Set<string>([...pauseTags, ...situationTags(situation)]);
  if (goal) tags.add(`goal:${goal}`);
  if (entities.some((e) => e.category === CATEGORY_RANK)) tags.add('rank_present');
  if (entities.some((e) => e.category === CATEGORY_DISCOVERY)) tags.add('discovery_present');
  if (entities.some((e) => e.category === CATEGORY_PROFIT)) tags.add('profit_present');
  if (entities.some((e) => e.category === CATEGORY_SHIELD)) tags.add('shield_present');
  return tags;
}

export interface BuildRecommendationsOptions {
  goal?: string | null;
  situation?: string | null;
  testCandidates?: TestCandidate[] | null;
  signalItems?: TestCandidate[] | null;
  config?: RecConfig | null;
  rankRadar?: RawRadarRow[] | null;
  pacing?: PacingResult | null;
}

/**
 * Top-level entry point.
 *
 * `rankRadar` drives the GRADUATE list and per-keyword rank protection;
 * omitting it reverts to the category rule alone and adds a note saying so,
 * because a silent gap reads as evidence that does not exist.
 */
export function buildRecommendations(
  rawEntities: RawEntity[],
  options: BuildRecommendationsOptions = {},
): RecommendationsResult {
  const thresholds = resolveRecThresholds(options.config);
  const entities = normalizeEntities(rawEntities);
  const radar = normalizeRankRadar(options.rankRadar);

  const push = generatePush(entities, thresholds, radar);
  const pause = generatePauseOptimize(entities, options.goal, thresholds, radar);
  const graduate = generateGraduate(radar, thresholds);
  const brandTags = computeBrandTags(entities, options.goal, options.situation, pause.tags);
  const tests = selectTests(brandTags, options.testCandidates, options.signalItems);

  const notes = [...pause.notes];
  if (entities.length === 0) {
    notes.push(
      'No AdLabs campaign/target-level rows supplied this week -- Push/Pause-Optimize lists are empty by construction, not a clean bill of health.',
    );
  }
  if (radar.size === 0 && entities.some((e) => e.category === CATEGORY_RANK)) {
    notes.push(
      'No Rank Radar rows supplied -- graduation and per-keyword rank protection were skipped; ' +
        'Rank reads above rest on the category rule alone, not live organic-rank data.',
    );
  }
  if (options.pacing && options.pacing.status === 'act' && options.pacing.pace !== null) {
    notes.push(
      `Run-rate governor: pace ${formatFixed(options.pacing.pace, 2)} is over the act threshold -- apply the cut order ` +
        'waste -> discovery -> profit; Rank last and ONLY by explicit operator decision.',
    );
  }
  if (tests.length === 0) {
    notes.push('No new tests warranted this week.');
  }

  return { push, pauseOptimize: pause.items, tests, notes, graduate };
}
