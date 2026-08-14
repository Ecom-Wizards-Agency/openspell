/**
 * Reading a panel out of the database, in one call.
 *
 * The route that renders the panel should not have to know which three tables a
 * verdict history is assembled from, and should certainly not open its own
 * connection per component. `loadCrosscheckPanel` opens one, reads, closes, and
 * returns a plain object — a server component can await it directly.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import { buildPanelModel } from './panel.js';
import type { CrosscheckPanelModel } from './panel.js';
import { readCampaignNames, readProfile } from './facts.js';
import { readResults } from './results.js';

export interface LoadPanelOptions {
  profileId: string;
  startDate?: string;
  endDate?: string;
}

export interface CrosscheckProfileOption {
  profileId: string;
  label: string;
  region: string;
}

export async function loadCrosscheckPanel(
  handle: DbHandle,
  options: LoadPanelOptions,
): Promise<CrosscheckPanelModel> {
  const rows = await readResults(handle, {
    profileId: options.profileId,
    startDate: options.startDate,
    endDate: options.endDate,
  });
  const campaignIds = [
    ...new Set(
      rows
        .filter((row) => row.grain === 'campaign_week' && row.entityId !== null)
        .map((row) => row.entityId as string),
    ),
  ];
  const names = await readCampaignNames(handle, options.profileId, campaignIds);
  return buildPanelModel(rows, { campaignNames: names, profileId: options.profileId });
}

/**
 * Profiles that have at least one verdict, for the panel's switcher. Labelled
 * with the account label when there is one, and never with anything the roster
 * rule forbids from a tracked file — this is runtime data, not a fixture.
 */
export async function listCrosscheckedProfiles(
  handle: DbHandle,
): Promise<CrosscheckProfileOption[]> {
  const rows = await handle.sql<
    { id: string; account_name: string | null; amazon_profile_id: string; region: string }[]
  >`
    select p.id, p.account_name, p.amazon_profile_id, p.region::text as region
    from public.ad_profiles p
    where exists (select 1 from public.crosscheck_results c where c.profile_id = p.id)
    order by p.account_name nulls last, p.amazon_profile_id
  `;
  return rows.map((row) => ({
    profileId: row.id,
    label: row.account_name ?? row.amazon_profile_id,
    region: row.region,
  }));
}

export interface OpenDatabaseOptions {
  connectionString?: string;
  variable?: string;
}

/**
 * A handle, or `null` when the environment has no database configured. Null
 * rather than a throw because a scaffold page that crashes the whole app when
 * an env var is missing is worse than one that says it is not wired up yet.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): DbHandle | null {
  try {
    const connectionString =
      options.connectionString ?? connectionStringFromEnv(process.env, options.variable);
    return createDb({ connectionString, max: 1 });
  } catch {
    return null;
  }
}

export async function withDatabase<T>(
  run: (handle: DbHandle) => Promise<T>,
  options: OpenDatabaseOptions = {},
): Promise<T | null> {
  const handle = openDatabase(options);
  if (handle === null) return null;
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

export async function loadProfileLabel(
  handle: DbHandle,
  profileId: string,
): Promise<string> {
  const profile = await readProfile(handle, profileId);
  return profile.accountLabel ?? profile.amazonProfileId;
}
