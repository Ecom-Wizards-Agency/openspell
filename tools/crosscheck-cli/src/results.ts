/**
 * Writing verdicts down, and reading them back.
 *
 * The write is an upsert on the grain key, because re-running a day is normal:
 * an export gets re-pulled, a restated report reloads our facts, and the
 * verdict has to move with them. It counts rows written against rows offered
 * and throws when they differ — program rule 4, in the one place where a
 * silently dropped row would turn "we compared 14 days" into a false claim
 * about a gate that unlocks writes.
 */
import type { DbHandle } from '@wizard-ads/db';
import type { CrosscheckFinding, ResultGrain, ResultMetric, ResultVerdict } from './compare.js';

export interface WriteCounts {
  offered: number;
  written: number;
}

export class ResultWriteCountMismatch extends Error {
  constructor(readonly counts: WriteCounts) {
    super(
      `crosscheck_results: offered ${counts.offered} rows, wrote ${counts.written}. ` +
        'A verdict that fails to land must not be reported as recorded.',
    );
    this.name = 'ResultWriteCountMismatch';
  }
}

export interface WriteContext {
  orgId: string;
  profileId: string;
  /** Groups the rows one ingest produced, so a run can be replayed or undone. */
  runId?: string;
}

export async function writeFindings(
  handle: DbHandle,
  context: WriteContext,
  findings: readonly CrosscheckFinding[],
): Promise<WriteCounts> {
  if (findings.length === 0) return { offered: 0, written: 0 };

  const rows = findings.map((finding) => ({
    org_id: context.orgId,
    profile_id: context.profileId,
    date: finding.date,
    grain: finding.grain,
    entity_id: finding.entityId,
    metric: finding.metric,
    ours: finding.ours,
    theirs: finding.theirs,
    delta_pct: finding.deltaPct,
    tolerance: finding.tolerance,
    verdict: finding.verdict,
    source: finding.source,
    run_id: context.runId ?? null,
  }));

  const written = await handle.sql<{ id: string }[]>`
    insert into public.crosscheck_results ${handle.sql(rows)}
    on conflict (profile_id, date, grain, entity_id, metric) do update set
      ours = excluded.ours,
      theirs = excluded.theirs,
      delta_pct = excluded.delta_pct,
      tolerance = excluded.tolerance,
      verdict = excluded.verdict,
      source = excluded.source,
      run_id = excluded.run_id,
      created_at = now()
    returning id
  `;

  const counts: WriteCounts = { offered: rows.length, written: written.length };
  if (counts.offered !== counts.written) throw new ResultWriteCountMismatch(counts);
  return counts;
}

export interface StoredResult {
  profileId: string;
  date: string;
  grain: ResultGrain;
  entityId: string | null;
  metric: ResultMetric;
  ours: number | null;
  theirs: number | null;
  deltaPct: number | null;
  tolerance: number;
  verdict: ResultVerdict;
  source: string | null;
}

export interface ReadResultsOptions {
  profileId?: string;
  orgId?: string;
  startDate?: string;
  endDate?: string;
  grain?: ResultGrain;
}

/** Verdict history, oldest first. The panel and the exit report share this read. */
export async function readResults(
  handle: DbHandle,
  options: ReadResultsOptions = {},
): Promise<StoredResult[]> {
  const rows = await handle.sql<
    {
      profile_id: string;
      date: string;
      grain: string;
      entity_id: string | null;
      metric: string;
      ours: string | null;
      theirs: string | null;
      delta_pct: string | null;
      tolerance: string;
      verdict: string;
      source: string | null;
    }[]
  >`
    select profile_id, date::text as date, grain, entity_id, metric,
           ours, theirs, delta_pct, tolerance, verdict, source
    from public.crosscheck_results
    where true
      ${options.profileId ? handle.sql`and profile_id = ${options.profileId}` : handle.sql``}
      ${options.orgId ? handle.sql`and org_id = ${options.orgId}` : handle.sql``}
      ${options.startDate ? handle.sql`and date >= ${options.startDate}` : handle.sql``}
      ${options.endDate ? handle.sql`and date <= ${options.endDate}` : handle.sql``}
      ${options.grain ? handle.sql`and grain = ${options.grain}` : handle.sql``}
    order by date, grain, entity_id nulls first, metric
  `;

  return rows.map((row) => ({
    profileId: row.profile_id,
    date: row.date,
    grain: row.grain as ResultGrain,
    entityId: row.entity_id,
    metric: row.metric as ResultMetric,
    ours: numeric(row.ours),
    theirs: numeric(row.theirs),
    deltaPct: numeric(row.delta_pct),
    tolerance: numeric(row.tolerance) ?? 0,
    verdict: row.verdict as ResultVerdict,
    source: row.source,
  }));
}

function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
