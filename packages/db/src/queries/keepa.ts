import { and, desc, eq, getTableColumns, inArray, isNull, ne } from 'drizzle-orm';
import type { DbHandle } from '../client.js';
import { insights } from '../schema/analysis.js';
import { productAds } from '../schema/entities.js';
import { integrationConnections } from '../schema/integrations.js';
import {
  competitorLinks,
  competitorPriceEvents,
  keepaBsrObservations,
} from '../schema/seams.js';
import type {
  CompetitorPriceEventKind,
  NewCompetitorPriceEvent,
  NewKeepaBsrObservation,
} from '../schema/seams.js';
import { adProfiles } from '../schema/tenancy.js';
import { chunkForInsert } from './chunk.js';
import { assertUniqueFactGrain } from './facts.js';

export interface IdentityLoadCounts {
  offered: number;
  existing: number;
  written: number;
}

export interface CompetitorEventLoadResult extends IdentityLoadCounts {
  inserted: Array<{
    asin: string;
    eventKind: CompetitorPriceEventKind;
    detectedAt: Date;
  }>;
}

export interface KeepaSyncScope {
  marketplace: string;
  ownAsins: string[];
  competitorLinks: CompetitorLinkRecord[];
}

export interface CompetitorLinkRecord {
  id: string;
  orgId: string;
  profileId: string | null;
  profileLabel: string | null;
  marketplace: string | null;
  ourAsin: string;
  competitorAsin: string;
  enabled: boolean;
  createdAt: Date;
}

export interface KeepaObservationRecord {
  asin: string;
  observedAt: Date;
  category: string;
  price: number | null;
  buyBoxPrice: number | null;
  lightningDeal: boolean | null;
  coupon: readonly [number, number] | null;
}

export interface ActiveKeepaConnection {
  id: string;
  config: Record<string, unknown>;
}

export async function activeKeepaConnection(
  handle: DbHandle,
  orgId: string,
): Promise<ActiveKeepaConnection | null> {
  const rows = await handle.db
    .select({ id: integrationConnections.id, config: integrationConnections.config })
    .from(integrationConnections)
    .where(and(
      eq(integrationConnections.orgId, orgId),
      eq(integrationConnections.provider, 'keepa'),
      eq(integrationConnections.status, 'active'),
    ))
    .orderBy(integrationConnections.connectedAt, integrationConnections.createdAt, integrationConnections.id)
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve the designated marketplace plus every allowed own/competitor ASIN. */
export async function resolveKeepaSyncScope(
  handle: DbHandle,
  input: { orgId: string; profileId: string; includeCompetitors: boolean },
): Promise<KeepaSyncScope> {
  const profiles = await handle.db
    .select({ marketplace: adProfiles.countryCode })
    .from(adProfiles)
    .where(and(eq(adProfiles.orgId, input.orgId), eq(adProfiles.id, input.profileId)))
    .limit(1);
  const profile = profiles[0];
  if (!profile) throw new Error('Keepa sync profile does not belong to the organisation');

  const own = await handle.db
    .selectDistinct({ asin: productAds.asin })
    .from(productAds)
    .where(and(
      eq(productAds.orgId, input.orgId),
      eq(productAds.profileId, input.profileId),
      isNull(productAds.deletedAt),
      ne(productAds.state, 'archived'),
    ));
  const links = input.includeCompetitors
    ? await listCompetitorLinks(handle, input.orgId, input.profileId)
    : [];
  return {
    marketplace: profile.marketplace,
    ownAsins: own.flatMap((row) => row.asin ? [row.asin.trim().toUpperCase()] : []),
    competitorLinks: links.filter((link) => link.enabled),
  };
}

export async function loadKeepaBsrObservations(
  handle: DbHandle,
  rows: readonly NewKeepaBsrObservation[],
): Promise<IdentityLoadCounts> {
  if (rows.length === 0) return { offered: 0, existing: 0, written: 0 };
  assertUniqueFactGrain('keepa_bsr_observations', rows, (row) => [
    row.orgId,
    row.asin,
    row.category ?? '',
    row.observedAt instanceof Date ? row.observedAt.toISOString() : String(row.observedAt),
  ]);

  let written = 0;
  for (const chunk of chunkForInsert(rows, Object.keys(getTableColumns(keepaBsrObservations)).length)) {
    const result = await handle.db
      .insert(keepaBsrObservations)
      .values(chunk)
      .onConflictDoNothing({
        target: [
          keepaBsrObservations.orgId,
          keepaBsrObservations.asin,
          keepaBsrObservations.category,
          keepaBsrObservations.observedAt,
        ],
      })
      .returning({ id: keepaBsrObservations.id });
    written += result.length;
  }
  return accounted(rows.length, written);
}

export async function loadNewCompetitorPriceEvents(
  handle: DbHandle,
  rows: readonly NewCompetitorPriceEvent[],
): Promise<CompetitorEventLoadResult> {
  if (rows.length === 0) return { offered: 0, existing: 0, written: 0, inserted: [] };
  assertUniqueFactGrain('competitor_price_events', rows, (row) => [
    row.orgId,
    row.asin,
    row.eventKind,
    row.detectedAt instanceof Date ? row.detectedAt.toISOString() : String(row.detectedAt),
  ]);

  const inserted: CompetitorEventLoadResult['inserted'] = [];
  for (const chunk of chunkForInsert(rows, Object.keys(getTableColumns(competitorPriceEvents)).length)) {
    const result = await handle.db
      .insert(competitorPriceEvents)
      .values(chunk)
      .onConflictDoNothing({
        target: [
          competitorPriceEvents.orgId,
          competitorPriceEvents.asin,
          competitorPriceEvents.eventKind,
          competitorPriceEvents.detectedAt,
        ],
      })
      .returning({
        asin: competitorPriceEvents.asin,
        eventKind: competitorPriceEvents.eventKind,
        detectedAt: competitorPriceEvents.detectedAt,
      });
    inserted.push(...result);
  }
  return { ...accounted(rows.length, inserted.length), inserted };
}

export async function latestKeepaObservations(
  handle: DbHandle,
  orgId: string,
  asins: readonly string[],
): Promise<KeepaObservationRecord[]> {
  if (asins.length === 0) return [];
  const rows = await handle.db
    .selectDistinctOn([keepaBsrObservations.asin], {
      asin: keepaBsrObservations.asin,
      observedAt: keepaBsrObservations.observedAt,
      category: keepaBsrObservations.category,
      price: keepaBsrObservations.price,
      buyBoxPrice: keepaBsrObservations.buyBoxPrice,
      lightningDeal: keepaBsrObservations.lightningDeal,
      coupon: keepaBsrObservations.coupon,
    })
    .from(keepaBsrObservations)
    .where(and(eq(keepaBsrObservations.orgId, orgId), inArray(keepaBsrObservations.asin, [...asins])))
    .orderBy(keepaBsrObservations.asin, desc(keepaBsrObservations.observedAt), desc(keepaBsrObservations.id));
  return rows;
}

export async function listCompetitorLinks(
  handle: DbHandle,
  orgId: string,
  profileId?: string,
): Promise<CompetitorLinkRecord[]> {
  const rows = await handle.sql<{
    id: string;
    org_id: string;
    profile_id: string | null;
    profile_label: string | null;
    marketplace: string | null;
    our_asin: string;
    competitor_asin: string;
    enabled: boolean;
    created_at: Date | string;
  }[]>`
    select l.id, l.org_id, l.profile_id,
           coalesce(p.account_name, p.amazon_profile_id) as profile_label,
           p.country_code as marketplace,
           l.our_asin, l.competitor_asin, l.enabled, l.created_at
      from public.competitor_links l
      left join public.ad_profiles p on p.id = l.profile_id and p.org_id = l.org_id
     where l.org_id = ${orgId}
       and (
         ${profileId ?? null}::uuid is null
         or l.profile_id is null
         or l.profile_id = ${profileId ?? null}::uuid
       )
     order by coalesce(p.account_name, p.amazon_profile_id), l.our_asin, l.competitor_asin, l.id
  `;
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    profileLabel: row.profile_label,
    marketplace: row.marketplace,
    ourAsin: row.our_asin,
    competitorAsin: row.competitor_asin,
    enabled: row.enabled,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }));
}

export async function createCompetitorLink(
  handle: DbHandle,
  input: { orgId: string; profileId: string; ourAsin: string; competitorAsin: string },
): Promise<CompetitorLinkRecord> {
  const ourAsin = normalizeAsin(input.ourAsin);
  const competitorAsin = normalizeAsin(input.competitorAsin);
  if (ourAsin === competitorAsin) throw new Error('A competitor ASIN must differ from our ASIN');
  const rows = await handle.sql<{ id: string }[]>`
    insert into public.competitor_links (org_id, profile_id, our_asin, competitor_asin, enabled)
    select p.org_id, p.id, ${ourAsin}, ${competitorAsin}, true
      from public.ad_profiles p
     where p.id = ${input.profileId} and p.org_id = ${input.orgId}
    on conflict (org_id, our_asin, competitor_asin) do update
      set profile_id = excluded.profile_id, enabled = true
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('Competitor link profile not found');
  const records = await listCompetitorLinks(handle, input.orgId);
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error('Created competitor link could not be read back');
  return record;
}

export async function removeCompetitorLink(
  handle: DbHandle,
  input: { orgId: string; id: string },
): Promise<void> {
  const rows = await handle.db
    .delete(competitorLinks)
    .where(and(eq(competitorLinks.orgId, input.orgId), eq(competitorLinks.id, input.id)))
    .returning({ id: competitorLinks.id });
  if (rows.length !== 1) throw new Error('Competitor link not found');
}

export async function markKeepaConnectionSynced(
  handle: DbHandle,
  connectionId: string,
  at: Date,
): Promise<void> {
  const rows = await handle.db
    .update(integrationConnections)
    .set({ lastSyncedAt: at, lastError: null, status: 'active' })
    .where(and(eq(integrationConnections.id, connectionId), eq(integrationConnections.provider, 'keepa')))
    .returning({ id: integrationConnections.id });
  if (rows.length !== 1) throw new Error('Keepa integration connection not found');
}

export async function writeKeepaDealInsight(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    asin: string;
    detectedAt: Date;
    price: number | null;
    baselinePrice: number | null;
    linkedOurAsins: readonly string[];
  },
): Promise<string> {
  const rows = await handle.db.insert(insights).values({
    orgId: input.orgId,
    profileId: input.profileId,
    date: input.detectedAt.toISOString().slice(0, 10),
    kind: 'competitor_deal',
    title: `Competitor deal started on ${input.asin}`,
    body: `Keepa detected a deal start for linked competitor ${input.asin}.`,
    figures: {
      asin: input.asin,
      price: input.price,
      baselinePrice: input.baselinePrice,
      linkedOurAsins: [...input.linkedOurAsins],
    },
    source: 'keepa',
  }).returning({ id: insights.id });
  const id = rows[0]?.id;
  if (!id) throw new Error('Keepa deal insight was not written');
  return id;
}

function accounted(offered: number, written: number): IdentityLoadCounts {
  const existing = offered - written;
  if (existing < 0 || existing + written !== offered) {
    throw new Error(`identity load accounting failed: offered ${offered}, existing ${existing}, written ${written}`);
  }
  return { offered, existing, written };
}

function normalizeAsin(value: string): string {
  const asin = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`Invalid ASIN ${JSON.stringify(value)}`);
  return asin;
}
