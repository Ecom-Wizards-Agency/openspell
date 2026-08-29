/**
 * Tenant-scoped optimization-group workspace and atomic internal writes.
 *
 * These writes configure Wizard Ads only. They never call Amazon and never
 * mutate an advertising entity. The full settings document and campaign set
 * move in one transaction so a rename or cadence edit cannot leave assignments
 * attached to a half-updated policy.
 */
import { randomUUID } from 'node:crypto';
import {
  OptimizationGroup,
  type AdProduct,
  type OptimizationGroup as OptimizationGroupValue,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';

export type OptimizationGroupSettings = Omit<
  OptimizationGroupValue,
  'id' | 'orgId' | 'profileId'
>;

export interface OptimizationCampaignChoice {
  campaignId: string;
  name: string;
  adProduct: AdProduct;
  state: string;
  dailyBudget: number | null;
  groupId: string | null;
}

export interface OptimizationGroupRunSummary {
  runId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  proposalsCount: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface OptimizationGroupRecord {
  group: OptimizationGroupValue;
  campaignIds: string[];
  nextRunAt: string | null;
  lastRun: OptimizationGroupRunSummary | null;
}

export interface OptimizationWorkspace {
  groups: OptimizationGroupRecord[];
  campaigns: OptimizationCampaignChoice[];
  assignedCampaigns: number;
  unassignedCampaigns: number;
}

export interface SaveOptimizationGroupInput {
  orgId: string;
  profileId: string;
  actorId: string;
  id?: string;
  settings: OptimizationGroupSettings;
  campaignIds: readonly string[];
}

export interface SaveOptimizationGroupResult {
  record: OptimizationGroupRecord;
  offeredCampaigns: number;
  assignedCampaigns: number;
  movedCampaigns: number;
  removedCampaigns: number;
}

interface GroupWireRow {
  id: string;
  org_id: string;
  profile_id: string;
  name: string;
  role: OptimizationGroupValue['role'];
  target_acos: string | number;
  bid_floor: string | number | null;
  bid_ceiling: string | number | null;
  bid_increase_cap: string | number;
  bid_decrease_cap: string | number;
  placement_increase_cap: string | number;
  placement_decrease_cap: string | number;
  exclusions: string[];
  cadence: string;
  prioritization: OptimizationGroupValue['prioritization'];
  enabled: boolean;
  next_run_at: Date | string | null;
  campaign_ids: string[] | null;
  last_run_id: string | null;
  last_run_status: OptimizationGroupRunSummary['status'] | null;
  last_run_proposals: string | number | null;
  last_run_created_at: Date | string | null;
  last_run_finished_at: Date | string | null;
}

interface CampaignWireRow {
  campaign_id: string;
  name: string;
  ad_product: AdProduct;
  state: string;
  daily_budget: string | number | null;
  group_id: string | null;
}

export class OptimizationGroupPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimizationGroupPersistenceError';
  }
}

/** One bounded read for the settings screen and Strategy Overview. */
export async function readOptimizationWorkspace(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string },
): Promise<OptimizationWorkspace> {
  const [groups, campaigns] = await Promise.all([
    handle.sql<GroupWireRow[]>`
      select g.id, g.org_id, g.profile_id, g.name, g.role::text as role,
             g.target_acos, g.bid_floor, g.bid_ceiling,
             g.bid_increase_cap, g.bid_decrease_cap,
             g.placement_increase_cap, g.placement_decrease_cap,
             g.exclusions, g.cadence::text as cadence,
             g.prioritization::text as prioritization, g.enabled, g.next_run_at,
             coalesce(assignments.campaign_ids, '{}'::text[]) as campaign_ids,
             latest.id as last_run_id, latest.status::text as last_run_status,
             latest.proposals_count as last_run_proposals,
             latest.created_at as last_run_created_at,
             latest.finished_at as last_run_finished_at
        from public.optimization_groups g
        left join lateral (
          select array_agg(a.campaign_id order by a.campaign_id) as campaign_ids
            from public.campaign_optimization_assignments a
           where a.org_id = ${input.orgId}
             and a.profile_id = ${input.profileId}
             and a.group_id = g.id
        ) assignments on true
        left join lateral (
          select r.id, r.status, r.proposals_count, r.created_at, r.finished_at
            from public.recommendation_runs r
           where r.org_id = ${input.orgId}
             and r.profile_id = ${input.profileId}
             and r.group_id = g.id
           order by r.created_at desc, r.id desc
           limit 1
        ) latest on true
       where g.org_id = ${input.orgId} and g.profile_id = ${input.profileId}
       order by
         case g.role when 'rank' then 1 when 'profit' then 2
                     when 'discovery' then 3 else 4 end,
         lower(g.name), g.id
    `,
    handle.sql<CampaignWireRow[]>`
      select c.amazon_id as campaign_id, c.name,
             c.ad_product::text as ad_product,
             case when c.deleted_at is null then c.state::text else 'deleted' end as state,
             c.budget_amount as daily_budget, a.group_id
        from public.campaigns c
        left join public.campaign_optimization_assignments a
          on a.org_id = ${input.orgId}
         and a.profile_id = ${input.profileId}
         and a.campaign_id = c.amazon_id
       where c.org_id = ${input.orgId}
         and c.profile_id = ${input.profileId}
         and c.deleted_at is null
       order by c.ad_product, lower(c.name), c.amazon_id
    `,
  ]);

  const records = groups.map(groupRecordFromWire);
  const campaignRows = campaigns.map((row) => ({
    campaignId: row.campaign_id,
    name: row.name,
    adProduct: row.ad_product,
    state: row.state,
    dailyBudget: numberOrNull(row.daily_budget),
    groupId: row.group_id,
  }));
  const assignedCampaigns = campaignRows.filter((campaign) => campaign.groupId !== null).length;
  return {
    groups: records,
    campaigns: campaignRows,
    assignedCampaigns,
    unassignedCampaigns: campaignRows.length - assignedCampaigns,
  };
}

/**
 * Create or replace one group's settings and exact assignment set.
 * Campaigns already assigned elsewhere move atomically to this group.
 */
export async function saveOptimizationGroup(
  handle: Pick<DbHandle, 'sql'>,
  input: SaveOptimizationGroupInput,
): Promise<SaveOptimizationGroupResult> {
  const id = input.id ?? randomUUID();
  const group = OptimizationGroup.parse({
    id,
    orgId: input.orgId,
    profileId: input.profileId,
    ...input.settings,
  });
  const campaignIds = uniqueNonempty(input.campaignIds);
  if (campaignIds.length !== input.campaignIds.length) {
    throw new OptimizationGroupPersistenceError('campaign assignments must be unique and nonempty');
  }

  return handle.sql.begin(async (sql) => {
    const [profile] = await sql<{ id: string }[]>`
      select id from public.ad_profiles
       where org_id = ${input.orgId} and id = ${input.profileId}
       for update
    `;
    if (!profile) throw new OptimizationGroupPersistenceError('profile not found in organisation');

    const existingAssignments = await sql<{ campaign_id: string; group_id: string }[]>`
      select campaign_id, group_id
        from public.campaign_optimization_assignments
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and (group_id = ${id} or campaign_id = any (${campaignIds}::text[]))
       for update
    `;

    const campaigns = campaignIds.length === 0
      ? []
      : await sql<{ campaign_id: string }[]>`
          select amazon_id as campaign_id from public.campaigns
           where org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and deleted_at is null
             and amazon_id = any (${campaignIds}::text[])
           order by amazon_id
           for share
        `;
    if (campaigns.length !== campaignIds.length) {
      throw new OptimizationGroupPersistenceError(
        `offered ${campaignIds.length} campaigns but found ${campaigns.length} in the profile`,
      );
    }

    const written = await sql<{ id: string }[]>`
      insert into public.optimization_groups (
        id, org_id, profile_id, name, role, target_acos,
        bid_floor, bid_ceiling, bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap, exclusions,
        cadence, prioritization, enabled, next_run_at
      ) values (
        ${group.id}, ${group.orgId}, ${group.profileId}, ${group.name},
        ${group.role}::public.optimization_group_role, ${group.targetAcos},
        ${group.bidFloor}, ${group.bidCeiling}, ${group.bidIncreaseCap},
        ${group.bidDecreaseCap}, ${group.placementIncreaseCap},
        ${group.placementDecreaseCap}, ${group.exclusions},
        ${group.cadence}::interval,
        ${group.prioritization}::public.optimization_prioritization,
        ${group.enabled}, case when ${group.enabled} then now() else null end
      )
      on conflict (id) do update set
        name = excluded.name,
        role = excluded.role,
        target_acos = excluded.target_acos,
        bid_floor = excluded.bid_floor,
        bid_ceiling = excluded.bid_ceiling,
        bid_increase_cap = excluded.bid_increase_cap,
        bid_decrease_cap = excluded.bid_decrease_cap,
        placement_increase_cap = excluded.placement_increase_cap,
        placement_decrease_cap = excluded.placement_decrease_cap,
        exclusions = excluded.exclusions,
        cadence = excluded.cadence,
        prioritization = excluded.prioritization,
        enabled = excluded.enabled,
        next_run_at = case
          when not excluded.enabled then null
          else coalesce(public.optimization_groups.next_run_at, now())
        end
      where public.optimization_groups.org_id = excluded.org_id
        and public.optimization_groups.profile_id = excluded.profile_id
      returning id
    `;
    if (written.length !== 1) {
      throw new OptimizationGroupPersistenceError('group ID belongs to another profile or organisation');
    }

    const removed = campaignIds.length === 0
      ? await sql<{ campaign_id: string }[]>`
          delete from public.campaign_optimization_assignments
           where org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and group_id = ${id}
          returning campaign_id
        `
      : await sql<{ campaign_id: string }[]>`
          delete from public.campaign_optimization_assignments
           where org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and group_id = ${id}
             and not (campaign_id = any (${campaignIds}::text[]))
          returning campaign_id
        `;

    const assigned = campaignIds.length === 0
      ? []
      : await sql<{ campaign_id: string }[]>`
          insert into public.campaign_optimization_assignments (
            org_id, profile_id, campaign_id, group_id, assigned_at, assigned_by
          )
          select ${input.orgId}, ${input.profileId}, campaign.campaign_id,
                 ${id}, now(), ${input.actorId}
            from unnest(${campaignIds}::text[]) as campaign(campaign_id)
          on conflict (profile_id, campaign_id) do update set
            org_id = excluded.org_id,
            group_id = excluded.group_id,
            assigned_at = excluded.assigned_at,
            assigned_by = excluded.assigned_by
          returning campaign_id
        `;
    if (assigned.length !== campaignIds.length) {
      throw new OptimizationGroupPersistenceError(
        `offered ${campaignIds.length} assignments but wrote ${assigned.length}`,
      );
    }

    const [record] = await readGroupRecords(sql, { orgId: input.orgId, profileId: input.profileId, id });
    if (!record) throw new OptimizationGroupPersistenceError('saved group was not readable');
    if (record.campaignIds.length !== campaignIds.length) {
      throw new OptimizationGroupPersistenceError(
        `wrote ${campaignIds.length} assignments but read back ${record.campaignIds.length}`,
      );
    }

    const movedCampaigns = existingAssignments.filter(
      (assignment) => campaignIds.includes(assignment.campaign_id) && assignment.group_id !== id,
    ).length;
    await sql`
      insert into public.audit_log (
        org_id, actor_type, actor_id, action, target_type, target_id, payload, source
      ) values (
        ${input.orgId}, 'user', ${input.actorId}, 'optimization_group.saved',
        'optimization_group', ${id},
        ${JSON.stringify({
          profileId: input.profileId,
          role: group.role,
          campaigns: campaignIds.length,
          movedCampaigns,
          removedCampaigns: removed.length,
          enabled: group.enabled,
        })}::jsonb,
        'web'
      )
    `;

    return {
      record,
      offeredCampaigns: campaignIds.length,
      assignedCampaigns: record.campaignIds.length,
      movedCampaigns,
      removedCampaigns: removed.length,
    };
  });
}

async function readGroupRecords(
  sql: QuerySql,
  input: { orgId: string; profileId: string; id: string },
): Promise<OptimizationGroupRecord[]> {
  const rows = await sql<GroupWireRow[]>`
    select g.id, g.org_id, g.profile_id, g.name, g.role::text as role,
           g.target_acos, g.bid_floor, g.bid_ceiling,
           g.bid_increase_cap, g.bid_decrease_cap,
           g.placement_increase_cap, g.placement_decrease_cap,
           g.exclusions, g.cadence::text as cadence,
           g.prioritization::text as prioritization, g.enabled, g.next_run_at,
           coalesce(assignments.campaign_ids, '{}'::text[]) as campaign_ids,
           latest.id as last_run_id, latest.status::text as last_run_status,
           latest.proposals_count as last_run_proposals,
           latest.created_at as last_run_created_at,
           latest.finished_at as last_run_finished_at
      from public.optimization_groups g
      left join lateral (
        select array_agg(a.campaign_id order by a.campaign_id) as campaign_ids
          from public.campaign_optimization_assignments a
         where a.org_id = ${input.orgId}
           and a.profile_id = ${input.profileId}
           and a.group_id = g.id
      ) assignments on true
      left join lateral (
        select r.id, r.status, r.proposals_count, r.created_at, r.finished_at
          from public.recommendation_runs r
         where r.org_id = ${input.orgId}
           and r.profile_id = ${input.profileId}
           and r.group_id = g.id
         order by r.created_at desc, r.id desc
         limit 1
      ) latest on true
     where g.org_id = ${input.orgId}
       and g.profile_id = ${input.profileId}
       and g.id = ${input.id}
  `;
  return rows.map(groupRecordFromWire);
}

function groupRecordFromWire(row: GroupWireRow): OptimizationGroupRecord {
  const group = OptimizationGroup.parse({
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    name: row.name,
    role: row.role,
    targetAcos: Number(row.target_acos),
    bidFloor: numberOrNull(row.bid_floor),
    bidCeiling: numberOrNull(row.bid_ceiling),
    bidIncreaseCap: Number(row.bid_increase_cap),
    bidDecreaseCap: Number(row.bid_decrease_cap),
    placementIncreaseCap: Number(row.placement_increase_cap),
    placementDecreaseCap: Number(row.placement_decrease_cap),
    exclusions: row.exclusions,
    cadence: row.cadence,
    prioritization: row.prioritization,
    enabled: row.enabled,
  });
  const lastRun =
    row.last_run_id === null ||
    row.last_run_status === null ||
    row.last_run_created_at === null
      ? null
      : {
          runId: row.last_run_id,
          status: row.last_run_status,
          proposalsCount: Number(row.last_run_proposals ?? 0),
          createdAt: toIso(row.last_run_created_at),
          finishedAt: row.last_run_finished_at === null ? null : toIso(row.last_run_finished_at),
        };
  return {
    group,
    campaignIds: row.campaign_ids ?? [],
    nextRunAt: row.next_run_at === null ? null : toIso(row.next_run_at),
    lastRun,
  };
}

function uniqueNonempty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
