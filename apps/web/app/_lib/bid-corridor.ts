/**
 * The bid corridor's reads, for the optimizer drill-down (WP-28).
 *
 * The corridor is a per-target daily series (`bid_series_daily`), synced by the
 * worker from Amazon's suggested-bid endpoints. This module turns it into the
 * `BidCorridorPoint[]` the chart plots, and lists the targets that have a
 * corridor so the surface can offer them as a chooser rather than a blank.
 *
 * Every read takes the actor's `orgId` alongside the profile id and puts both in
 * the predicate — defence in depth, since the web tier connects as the service
 * role and "already checked upstream" is the only lock this layer has.
 */
import {
  listBidSeriesTargets,
  readBidSeries,
  type BidSeriesTarget,
  type DbHandle,
} from '@wizard-ads/db';
import type { BidCorridorPoint } from '../../src/ui/viz';

/** How many days of corridor the drill-down shows, ending at the window end. */
export const CORRIDOR_WINDOW_DAYS = 30;

/** The corridor window: `days` back from (and including) `endIso`. */
export function corridorWindow(endIso: string, days = CORRIDOR_WINDOW_DAYS): { from: string; to: string } {
  const end = new Date(`${endIso}T00:00:00Z`);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { from: start.toISOString().slice(0, 10), to: endIso };
}

/** The targets that carry a corridor in the window, most-recent first. */
export async function loadCorridorTargets(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  window: { from: string; to: string },
): Promise<BidSeriesTarget[]> {
  return listBidSeriesTargets(handle, { orgId, profileId, from: window.from, to: window.to });
}

/** One target's corridor over the window, oldest first, as chart points. */
export async function loadCorridor(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  targetId: string,
  window: { from: string; to: string },
): Promise<BidCorridorPoint[]> {
  const rows = await readBidSeries(handle, {
    orgId,
    profileId,
    targetId,
    from: window.from,
    to: window.to,
  });
  return rows.map((row) => ({
    date: row.date,
    low: row.suggestedBidLow,
    median: row.suggestedBidMedian,
    high: row.suggestedBidHigh,
    bid: row.bid,
    cpc: row.cpc,
    maxCpc: row.maxPotentialCpc,
    components: row.modifierComponents ?? [],
  }));
}
