import type { DbHandle } from '@wizard-ads/db';

export interface DashboardOperatingStatus {
  campaigns: {
    total: number;
    assigned: number;
    unassigned: number;
  };
  groupCount: number;
  stagedBatch: {
    optGroup: string;
    lever: string;
    rows: number;
  } | null;
  observations: {
    synchronized: number;
    settling: number;
    complete: number;
    hold: number;
    revert: number;
  };
  stockSignals: number;
}

interface OperatingStatusWire {
  campaigns_total: number | string | null;
  campaigns_assigned: number | string | null;
  group_count: number | string | null;
  batch_opt_group: string | null;
  batch_lever: string | null;
  batch_rows: number | string | null;
  observations_synchronized: number | string | null;
  observations_settling: number | string | null;
  observations_complete: number | string | null;
  observations_hold: number | string | null;
  observations_revert: number | string | null;
  stock_signals: number | string | null;
}

/**
 * One tenant/profile-scoped round trip for the Dashboard's compact operating card.
 *
 * The dedicated Strategy and Optimization Group pages intentionally load their
 * complete records. The Dashboard only renders counts and the latest staged
 * batch, so loading those full workspaces here multiplied database round trips
 * without giving the operator more information.
 */
export async function readDashboardOperatingStatus(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<DashboardOperatingStatus> {
  const [row] = await handle.sql<OperatingStatusWire[]>`
    select
      campaigns.total::int as campaigns_total,
      campaigns.assigned::int as campaigns_assigned,
      (select count(*)::int
         from public.optimization_groups g
        where g.org_id = ${input.orgId}
          and g.profile_id = ${input.profileId}) as group_count,
      batch.opt_group as batch_opt_group,
      batch.lever as batch_lever,
      batch.rows::int as batch_rows,
      observations.synchronized::int as observations_synchronized,
      observations.settling::int as observations_settling,
      observations.complete::int as observations_complete,
      observations.hold::int as observations_hold,
      observations.revert::int as observations_revert,
      (select count(*)::int
         from public.supa_flags f
        where f.org_id = ${input.orgId}
          and f.profile_id = ${input.profileId}
          and coalesce(f.out_of_stock_days, 0) > 0) as stock_signals
      from (values (1)) as root(seed)
      left join lateral (
        select count(*)::int as total,
               count(*) filter (where a.group_id is not null)::int as assigned
          from public.campaigns c
          left join public.campaign_optimization_assignments a
            on a.org_id = ${input.orgId}
           and a.profile_id = ${input.profileId}
           and a.campaign_id = c.amazon_id
         where c.org_id = ${input.orgId}
           and c.profile_id = ${input.profileId}
           and c.deleted_at is null
      ) campaigns on true
      left join lateral (
        select count(*) filter (where synchronized_at is not null)::int as synchronized,
               count(*) filter (where evidence_state in ('awaiting_sync', 'observing'))::int as settling,
               count(*) filter (where evidence_state = 'complete')::int as complete,
               count(*) filter (where decision = 'hold')::int as hold,
               count(*) filter (where decision = 'revert')::int as revert
          from public.recommendation_observations o
         where o.org_id = ${input.orgId}
           and o.profile_id = ${input.profileId}
      ) observations on true
      left join lateral (
        select b.opt_group, b.lever,
               (select count(*)::int
                  from public.apply_rows r
                 where r.org_id = ${input.orgId}
                   and r.profile_id = ${input.profileId}
                   and r.batch_id = b.id) as rows
          from public.apply_batches b
         where b.org_id = ${input.orgId}
           and b.profile_id = ${input.profileId}
           and b.status = 'staged'
         order by b.exported_at desc, b.id desc
         limit 1
      ) batch on true
  `;

  const total = count(row?.campaigns_total);
  const assigned = Math.min(total, count(row?.campaigns_assigned));
  const stagedBatch =
    row?.batch_opt_group === null || row?.batch_opt_group === undefined
      || row.batch_lever === null || row.batch_lever === undefined
      ? null
      : {
          optGroup: row.batch_opt_group,
          lever: row.batch_lever,
          rows: count(row.batch_rows),
        };

  return {
    campaigns: {
      total,
      assigned,
      unassigned: total - assigned,
    },
    groupCount: count(row?.group_count),
    stagedBatch,
    observations: {
      synchronized: count(row?.observations_synchronized),
      settling: count(row?.observations_settling),
      complete: count(row?.observations_complete),
      hold: count(row?.observations_hold),
      revert: count(row?.observations_revert),
    },
    stockSignals: count(row?.stock_signals),
  };
}

function count(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}
