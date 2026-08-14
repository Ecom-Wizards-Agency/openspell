/**
 * The profile roster, and the two things a human may change about it.
 *
 * Reads are filtered in SQL rather than in the page, because the agency grant
 * returns on the order of two hundred profiles and "render them all, hide most"
 * is how a settings page becomes the slowest route in the product.
 *
 * Writes are narrow on purpose. There is no general "update profile": there is
 * a sync toggle (a cost decision, admin and above) and a targets edit (a
 * doctrine input, analyst and above). Both scope the statement by `org_id` as
 * well as `id`, so a guessed uuid from another tenant updates nothing, and both
 * verify the row count rather than trusting that the statement ran.
 */
import type { DbHandle } from '@wizard-ads/db';
import type { Region } from '@wizard-ads/shared';

export interface ProfileRow {
  id: string;
  amazonProfileId: string;
  region: Region;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  timezoneLocked: boolean;
  preferredSyncHour: number | null;
  accountType: string | null;
  accountName: string | null;
  syncEnabled: boolean;
  targetAcos: number | null;
  targetTotalAcos: number | null;
  goalLens: string | null;
  monthlyBudget: number | null;
  syncedAt: string | null;
}

/** How the roster is ordered. `name` leads with the human account name. */
export type RosterSort = 'name' | 'country' | 'region';

export const ROSTER_SORTS: readonly RosterSort[] = ['name', 'country', 'region'];

export function isRosterSort(value: unknown): value is RosterSort {
  return typeof value === 'string' && (ROSTER_SORTS as readonly string[]).includes(value);
}

export interface RosterFilter {
  region?: string | null;
  country?: string | null;
  /** Matches account name or Amazon profile id, case-insensitively. */
  search?: string | null;
  syncEnabled?: boolean | null;
  /** Defaults to `name`. */
  sort?: RosterSort | null;
}

export interface Roster {
  rows: ProfileRow[];
  /** Every profile in the org, before filtering: the "3 of 211" denominator. */
  total: number;
  /** Distinct country codes present, for the filter control. */
  countries: string[];
  /** Profiles per region, before filtering. The number the connect flow reports. */
  regionCounts: Record<string, number>;
}

export async function loadRoster(
  handle: DbHandle,
  orgId: string,
  filter: RosterFilter = {},
): Promise<Roster> {
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const region = filter.region?.trim() || null;
  const country = filter.country?.trim() || null;
  const syncEnabled = filter.syncEnabled ?? null;
  const sort: RosterSort = filter.sort ?? 'name';

  // The sort is a validated enum, never user text, so composing it as a SQL
  // fragment is safe. Name is the default; the other two keep name as the
  // within-group tiebreak so the order is always fully determined.
  const nameKey = handle.sql`coalesce(account_name, amazon_profile_id)`;
  const orderBy =
    sort === 'region'
      ? handle.sql`order by region, country_code, ${nameKey}`
      : sort === 'country'
        ? handle.sql`order by country_code, ${nameKey}`
        : handle.sql`order by ${nameKey}`;

  const rows = await handle.sql<ProfileRecord[]>`
    select id,
           amazon_profile_id,
           region::text as region,
           country_code,
           currency_code,
           timezone,
           timezone_locked,
           preferred_sync_hour,
           account_type::text as account_type,
           account_name,
           sync_enabled,
           target_acos,
           target_total_acos,
           goal_lens,
           monthly_budget,
           synced_at::text as synced_at
      from public.ad_profiles
     where org_id = ${orgId}
       and (${region}::text is null or region::text = ${region})
       and (${country}::text is null or country_code = ${country})
       and (${syncEnabled}::boolean is null or sync_enabled = ${syncEnabled})
       and (
         ${search}::text is null
         or account_name ilike ${search}
         or amazon_profile_id ilike ${search}
       )
     ${orderBy}
  `;

  const summary = await handle.sql<{ region: string; n: string }[]>`
    select region::text as region, count(*) as n
      from public.ad_profiles
     where org_id = ${orgId}
     group by region
  `;
  const countryRows = await handle.sql<{ country_code: string }[]>`
    select distinct country_code from public.ad_profiles where org_id = ${orgId}
     order by country_code
  `;

  const regionCounts: Record<string, number> = {};
  let total = 0;
  for (const row of summary) {
    const n = Number(row.n);
    regionCounts[row.region] = n;
    total += n;
  }

  return {
    rows: rows.map(toProfileRow),
    total,
    countries: countryRows.map((row) => row.country_code),
    regionCounts,
  };
}

export interface TargetEdit {
  targetAcos: number | null;
  targetTotalAcos: number | null;
  goalLens: string | null;
  monthlyBudget: number | null;
}

/** Analyst and above. Returns the updated row; throws when nothing matched. */
export async function updateProfileTargets(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  edit: TargetEdit,
): Promise<ProfileRow> {
  const rows = await handle.sql<ProfileRecord[]>`
    update public.ad_profiles
       set target_acos = ${edit.targetAcos},
           target_total_acos = ${edit.targetTotalAcos},
           goal_lens = ${edit.goalLens},
           monthly_budget = ${edit.monthlyBudget}
     where id = ${profileId} and org_id = ${orgId}
    returning id, amazon_profile_id, region::text as region, country_code, currency_code,
              timezone, timezone_locked, preferred_sync_hour,
              account_type::text as account_type, account_name, sync_enabled,
              target_acos, target_total_acos, goal_lens, monthly_budget, synced_at::text as synced_at
  `;
  const row = rows[0];
  if (!row) throw new Error(`no profile ${profileId} in this org`);
  return toProfileRow(row);
}

/** Admin and above: this one costs money. */
export async function setProfileSyncEnabled(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  enabled: boolean,
): Promise<ProfileRow> {
  const rows = await handle.sql<ProfileRecord[]>`
    update public.ad_profiles
       set sync_enabled = ${enabled}
     where id = ${profileId} and org_id = ${orgId}
    returning id, amazon_profile_id, region::text as region, country_code, currency_code,
              timezone, timezone_locked, preferred_sync_hour,
              account_type::text as account_type, account_name, sync_enabled,
              target_acos, target_total_acos, goal_lens, monthly_budget, synced_at::text as synced_at
  `;
  const row = rows[0];
  if (!row) throw new Error(`no profile ${profileId} in this org`);
  return toProfileRow(row);
}

/**
 * Admin and above: turn sync on or off for many profiles at once.
 *
 * One statement over an id array rather than a loop, and scoped by `org_id` as
 * well as the ids, so a guessed uuid from another tenant is silently a no-op.
 * Returns the number of rows actually changed, which the caller checks against
 * the number requested: a bulk action that quietly touched fewer rows than it
 * was asked to is a bug, not a success (program rule 4).
 */
export async function setProfilesSyncEnabled(
  handle: DbHandle,
  orgId: string,
  profileIds: readonly string[],
  enabled: boolean,
): Promise<number> {
  if (profileIds.length === 0) return 0;
  const rows = await handle.sql<{ id: string }[]>`
    update public.ad_profiles
       set sync_enabled = ${enabled}
     where org_id = ${orgId}
       and id = any(${profileIds as string[]}::uuid[])
    returning id
  `;
  return rows.length;
}

export interface ScheduleEdit {
  /** IANA timezone. Setting it pins the profile's timezone against Amazon re-sync. */
  timezone: string | null;
  /** 0–23 in the profile's own timezone, or null to clear the preference. */
  preferredSyncHour: number | null;
}

/**
 * Admin and above: the per-profile scheduling knobs.
 *
 * Setting a timezone by hand sets `timezone_locked`, which is what stops the
 * next OAuth upsert from overwriting it — the "sticky timezone" the operator
 * asked for. A null timezone leaves both the timezone and the lock untouched, so
 * clearing only the hour does not silently unpin a calendar someone chose.
 */
export async function updateProfileSchedule(
  handle: DbHandle,
  orgId: string,
  profileId: string,
  edit: ScheduleEdit,
): Promise<ProfileRow> {
  if (edit.preferredSyncHour !== null && (edit.preferredSyncHour < 0 || edit.preferredSyncHour > 23)) {
    throw new Error('a preferred sync hour must be between 0 and 23');
  }
  const timezone = edit.timezone?.trim() ? edit.timezone.trim() : null;
  const rows = await handle.sql<ProfileRecord[]>`
    update public.ad_profiles
       set preferred_sync_hour = ${edit.preferredSyncHour},
           timezone = coalesce(${timezone}, timezone),
           timezone_locked = case when ${timezone}::text is null then timezone_locked else true end
     where id = ${profileId} and org_id = ${orgId}
    returning id, amazon_profile_id, region::text as region, country_code, currency_code,
              timezone, timezone_locked, preferred_sync_hour,
              account_type::text as account_type, account_name, sync_enabled,
              target_acos, target_total_acos, goal_lens, monthly_budget, synced_at::text as synced_at
  `;
  const row = rows[0];
  if (!row) throw new Error(`no profile ${profileId} in this org`);
  return toProfileRow(row);
}

interface ProfileRecord {
  id: string;
  amazon_profile_id: string;
  region: string;
  country_code: string;
  currency_code: string;
  timezone: string;
  timezone_locked: boolean;
  preferred_sync_hour: number | null;
  account_type: string | null;
  account_name: string | null;
  sync_enabled: boolean;
  target_acos: string | null;
  target_total_acos: string | null;
  goal_lens: string | null;
  monthly_budget: string | null;
  synced_at: string | null;
}

function toProfileRow(row: ProfileRecord): ProfileRow {
  return {
    id: row.id,
    amazonProfileId: row.amazon_profile_id,
    region: row.region as Region,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    timezoneLocked: row.timezone_locked,
    preferredSyncHour: row.preferred_sync_hour === null ? null : Number(row.preferred_sync_hour),
    accountType: row.account_type,
    accountName: row.account_name,
    syncEnabled: row.sync_enabled,
    // postgres.js returns `numeric` as a string, on purpose: it does not fit a
    // double. These four are small enough that a number is safe, and a form
    // needs one.
    targetAcos: numeric(row.target_acos),
    targetTotalAcos: numeric(row.target_total_acos),
    goalLens: row.goal_lens,
    monthlyBudget: numeric(row.monthly_budget),
    syncedAt: row.synced_at,
  };
}

function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
