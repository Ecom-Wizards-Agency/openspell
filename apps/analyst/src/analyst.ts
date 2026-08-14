/**
 * The orchestrator: one pass over every sync-enabled profile.
 *
 * For each profile it assembles a briefing entirely from MCP reads — the
 * per-profile context resource, sync freshness, the profile-grain headline with
 * period deltas, the doctrine flags and month-to-date pacing — runs the pure
 * analyzer over it, renders the digest, and (unless this is a dry run) writes the
 * insight. Nothing account-shaped is read over the database handle; the handle
 * exists only to receive the finished row.
 *
 * A failure on one profile is caught and recorded, not thrown: a single account
 * with a bad window must not cost the other accounts their digest.
 */
import type { DbHandle } from '@wizard-ads/db';
import { analyzeProfile } from './analyze.js';
import type { AnalysisFigures, ProfileAnalysis } from './analyze.js';
import { renderDigest } from './digest.js';
import { writeInsight } from './insights-writer.js';
import type { AnalystMcpClient } from './mcp-client.js';
import type { AnalystConfig } from './config.js';

export interface ProfileResult {
  profileId: string;
  accountName: string;
  currency: string;
  reportDate: string;
  /** The insight row id, or null on a dry run or a skipped/failed profile. */
  insightId: string | null;
  findingsCount: number;
  figures: AnalysisFigures | null;
  markdown: string;
  error: string | null;
}

export interface AnalystRunResult {
  runDate: string;
  dryRun: boolean;
  profilesConsidered: number;
  profilesAnalyzed: number;
  insightsWritten: number;
  results: ProfileResult[];
}

export interface RunDeps {
  mcp: AnalystMcpClient;
  handle: Pick<DbHandle, 'sql'>;
  config: AnalystConfig;
  /** Injectable clock, so a test pins the fallback date. */
  now?: () => Date;
}

function todayIso(now: () => Date): string {
  return now().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` arithmetic in UTC, so a window never drifts by a timezone. */
function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function runDailyAnalyst(deps: RunDeps): Promise<AnalystRunResult> {
  const { mcp, handle, config } = deps;
  const now = deps.now ?? (() => new Date());
  const runDate = config.asOf ?? todayIso(now);

  const list = await mcp.listProfiles();
  const enabled = list.profiles.filter((profile) => profile.syncEnabled);

  const results: ProfileResult[] = [];
  let analyzed = 0;
  let written = 0;

  for (const profile of enabled) {
    try {
      const sync = await mcp.getSyncStatus(profile.id);
      const asOf = config.asOf ?? sync.latestFactDate ?? null;
      const reportDate = asOf ?? runDate;
      const window = {
        start: addDays(reportDate, -(config.lookbackDays - 1)),
        end: reportDate,
      };

      const [context, entity, flags, pacing] = await Promise.all([
        mcp.readProfileContext(profile.id),
        mcp.getEntityData({ entity: 'profile', profileId: profile.id, dateRange: window, compare: true }),
        mcp.getFlags(profile.id, asOf ?? undefined),
        mcp.getPacing(profile.id, asOf ?? undefined),
      ]);

      const analysis: ProfileAnalysis = analyzeProfile({
        profile,
        context,
        window: { from: window.start, to: window.end },
        entity,
        flags,
        pacing,
        asOf: sync.latestFactDate ?? entity.freshness.latestFactDate,
        provisional: sync.latestFactProvisional,
      });
      analyzed += 1;

      const markdown = renderDigest(analysis, profile.currencyCode);
      const writeDate = analysis.reportDate ?? reportDate;

      let insightId: string | null = null;
      if (!config.dryRun) {
        const insight = await writeInsight(handle, {
          profileId: profile.id,
          date: writeDate,
          kind: analysis.kind,
          title: analysis.title,
          body: markdown,
          figures: analysis.figures,
        });
        insightId = insight.id;
        written += 1;
      }

      results.push({
        profileId: profile.id,
        accountName: analysis.accountName,
        currency: profile.currencyCode,
        reportDate: writeDate,
        insightId,
        findingsCount: analysis.findings.length,
        figures: analysis.figures,
        markdown,
        error: null,
      });
    } catch (error) {
      results.push({
        profileId: profile.id,
        accountName: profile.accountName ?? `${profile.countryCode} ${profile.amazonProfileId}`,
        currency: profile.currencyCode,
        reportDate: runDate,
        insightId: null,
        findingsCount: 0,
        figures: null,
        markdown: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    runDate,
    dryRun: config.dryRun,
    profilesConsidered: enabled.length,
    profilesAnalyzed: analyzed,
    insightsWritten: written,
    results,
  };
}
