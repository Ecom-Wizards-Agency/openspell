/**
 * The chart-overlay provider (WP-19).
 *
 * A thin adapter from the database's experiment windows to the `ChartWindow`
 * shape the trend chart shades. It is deliberately small and side-effect free so
 * the dashboard can call it alongside its other reads without taking on the
 * experiment feature's weight, and so a profile with no live experiments costs
 * one indexed query and returns an empty array.
 */
import { listExperimentWindows } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { ChartWindow } from '../../src/ui/viz';

export async function loadExperimentWindows(
  handle: DbHandle,
  orgId: string,
  profileId: string,
): Promise<ChartWindow[]> {
  const windows = await listExperimentWindows(handle, { orgId, profileId });
  return windows.map((window) => ({
    id: window.id,
    label: window.name,
    start: window.start,
    end: window.end,
  }));
}
