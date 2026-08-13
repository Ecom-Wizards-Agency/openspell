/**
 * Profile roster, doctrine, and the staged-apply cooldown.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { TenantStrategy } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { adProfiles, profileStrategy } from '../schema/tenancy.js';
import type { AdProfile } from '../schema/tenancy.js';

export type { TenantStrategy } from '@wizard-ads/shared';

/**
 * Validate a doctrine document against the contract.
 *
 * Exposed so the operator-run seeder fails in front of a human, with a path to
 * the offending key, instead of at 03:00 in the middle of a recommendation run.
 */
export const parseStrategyDocument = (doc: unknown): TenantStrategy => TenantStrategy.parse(doc);

/** The profiles the sync worker is allowed to spend money on. */
export async function listSyncEnabledProfiles(
  handle: DbHandle,
  orgId?: string,
): Promise<AdProfile[]> {
  const where = orgId
    ? and(eq(adProfiles.syncEnabled, true), eq(adProfiles.orgId, orgId))
    : eq(adProfiles.syncEnabled, true);
  return handle.db.select().from(adProfiles).where(where).orderBy(adProfiles.amazonProfileId);
}

/**
 * The doctrine document in force for a profile: its own row if it has one,
 * otherwise the org default. Returns null when the tenant has never been
 * seeded, which callers must treat as "cannot run", never as "use defaults".
 */
export async function resolveStrategy(
  handle: DbHandle,
  orgId: string,
  profileId: string | null,
): Promise<TenantStrategy | null> {
  const rows = await handle.db
    .select()
    .from(profileStrategy)
    .where(
      and(
        eq(profileStrategy.orgId, orgId),
        profileId
          ? sql`(${profileStrategy.profileId} = ${profileId} or ${profileStrategy.profileId} is null)`
          : isNull(profileStrategy.profileId),
      ),
    )
    // A profile-specific row sorts before the org default, because `nulls last`.
    .orderBy(sql`${profileStrategy.profileId} nulls last`, desc(profileStrategy.updatedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return TenantStrategy.parse(row.doc);
}

/**
 * Write a tenant's doctrine document. Validated against the contract before it
 * reaches the database: a malformed strategy must fail at the seeder, where a
 * human is watching, not at 03:00 inside a recommendation run.
 */
export async function upsertStrategy(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string | null;
    doc: unknown;
    source?: string;
    updatedBy?: string | null;
  },
): Promise<{ id: string; profileId: string | null }> {
  const doc = TenantStrategy.parse(input.doc);

  const rows = await handle.db
    .insert(profileStrategy)
    .values({
      orgId: input.orgId,
      profileId: input.profileId,
      schemaVersion: doc.schema,
      doc,
      refreshedAt: doc.refreshed_at ?? null,
      source: input.source ?? null,
      updatedBy: input.updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [profileStrategy.orgId, profileStrategy.profileId],
      set: {
        schemaVersion: doc.schema,
        doc,
        refreshedAt: doc.refreshed_at ?? null,
        source: input.source ?? null,
        updatedBy: input.updatedBy ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: profileStrategy.id, profileId: profileStrategy.profileId });

  const row = rows[0];
  if (!row) throw new Error('upsertStrategy wrote no row');
  return row;
}

export interface CooldownConflict {
  entityKey: string;
  entityName: string | null;
  batchTag: string;
  appliedOn: string;
  daysAgo: number;
  freeOn: string;
}

/**
 * Which candidate entities an applied batch touched inside the cooldown.
 *
 * Ported from the Python staged-apply ledger, keys included: an entity is
 * addressed as `<entity_type>:<entity_id>`, so the two systems can be handed
 * the same list.
 */
export async function applyCooldownConflicts(
  handle: DbHandle,
  profileId: string,
  entityKeys: readonly string[],
  cooldownDays = 7,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<CooldownConflict[]> {
  if (entityKeys.length === 0) return [];
  const rows = await handle.sql<
    {
      entity_key: string;
      entity_name: string | null;
      batch_tag: string;
      applied_on: string;
      days_ago: number;
      free_on: string;
    }[]
  >`
    select entity_key, entity_name, batch_tag, applied_on::text, days_ago, free_on::text
    from public.apply_cooldown_conflicts(
      ${profileId}, ${handle.sql.array([...entityKeys])}, ${cooldownDays}, ${today}::date
    )
  `;
  return rows.map((row) => ({
    entityKey: row.entity_key,
    entityName: row.entity_name,
    batchTag: row.batch_tag,
    appliedOn: row.applied_on,
    daysAgo: row.days_ago,
    freeOn: row.free_on,
  }));
}
