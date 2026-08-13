/**
 * Synthetic development data: one org, a handful of profiles across three
 * regions, an entity mirror, and 60 days of facts.
 *
 * Everything here is generated from a fixed seed, so two developers looking at
 * the same grid see the same numbers, and re-running is idempotent rather than
 * additive. Nothing in this file came from a real account, and nothing ever
 * may: a fixture built from live data is a client data leak with extra steps.
 *
 * Usage:
 *
 *   pnpm --filter @wizard-ads/db seed:dev [-- --days 60 --force]
 *
 * Refuses to run against a non-local database unless `--force` is passed,
 * because "seed the dev data" and "the production connection string was still
 * exported" are two things that happen on the same afternoon.
 */
import {
  connectionStringFromEnv,
  createDb,
  ensureFactPartitions,
  upsertProfileFacts,
  upsertSearchTermFacts,
  upsertSpTargetFacts,
} from '../../packages/db/src/index.js';
import type { DbHandle, NewProfileFact, NewSearchTermFact, NewSpTargetFact } from '../../packages/db/src/index.js';

const ORG_SLUG = 'wizard-ads-dev';
const DEV_USER_ID = '00000000-0000-4000-8000-00000000d001';

/** Synthetic profiles. Region, currency and timezone vary on purpose: they are what breaks. */
const PROFILES = [
  { amazonProfileId: 'dev-1001', region: 'NA', country: 'US', currency: 'USD', tz: 'America/Los_Angeles' },
  { amazonProfileId: 'dev-1002', region: 'NA', country: 'CA', currency: 'CAD', tz: 'America/Toronto' },
  { amazonProfileId: 'dev-2001', region: 'EU', country: 'DE', currency: 'EUR', tz: 'Europe/Berlin' },
  { amazonProfileId: 'dev-3001', region: 'FE', country: 'JP', currency: 'JPY', tz: 'Asia/Tokyo' },
] as const;

const KEYWORDS = ['blue widget', 'widget set', 'metal widget', 'widget for desk', 'widget gift'];

/** Deterministic pseudo-random. A dev fixture that changes under you is not a fixture. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function isLocal(connectionString: string): boolean {
  const host = new URL(connectionString).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function ensureOrg(handle: DbHandle): Promise<{ orgId: string }> {
  await handle.sql`
    insert into auth.users (id) values (${DEV_USER_ID}) on conflict (id) do nothing
  `.catch(() => {
    throw new Error(
      'could not create the development user in auth.users. On a hosted project, create ' +
        'a user through Supabase Auth first and add them to the org by hand.',
    );
  });

  const rows = await handle.sql<{ id: string }[]>`
    insert into public.orgs (slug, name) values (${ORG_SLUG}, 'wizard-ads development')
    on conflict (slug) do update set name = excluded.name
    returning id
  `;
  const org = rows[0];
  if (!org) throw new Error('failed to create the development org');

  await handle.sql`
    insert into public.org_members (org_id, user_id, role)
    values (${org.id}, ${DEV_USER_ID}, 'owner')
    on conflict (org_id, user_id) do update set role = excluded.role
  `;

  return { orgId: org.id };
}

async function ensureProfiles(handle: DbHandle, orgId: string): Promise<Map<string, string>> {
  const written = new Map<string, string>();

  for (const profile of PROFILES) {
    const rows = await handle.sql<{ id: string; amazon_profile_id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone,
         sync_enabled, account_name)
      values (${orgId}, ${profile.amazonProfileId}, ${profile.region}, ${profile.country},
              ${profile.currency}, ${profile.tz}, true, ${`Dev ${profile.country}`})
      on conflict (org_id, amazon_profile_id) do update
        set sync_enabled = excluded.sync_enabled, account_name = excluded.account_name
      returning id, amazon_profile_id
    `;
    const row = rows[0];
    if (row) written.set(row.amazon_profile_id, row.id);
  }

  // Rule 45, even in a seed script: profiles offered against profiles written.
  if (written.size !== PROFILES.length) {
    throw new Error(`offered ${PROFILES.length} profiles, wrote ${written.size}`);
  }
  return written;
}

async function ensureMirror(
  handle: DbHandle,
  orgId: string,
  profiles: Map<string, string>,
): Promise<void> {
  for (const [amazonProfileId, profileId] of profiles) {
    const campaignId = `${amazonProfileId}-c1`;
    const adGroupId = `${amazonProfileId}-ag1`;

    await handle.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type, targeting_type)
      values (${orgId}, ${profileId}, ${campaignId}, 'SP', 'Dev | SP | Exact | Widget', 'enabled', 50, 'daily', 'manual')
      on conflict (profile_id, amazon_id) do update set synced_at = now()
    `;
    await handle.sql`
      insert into public.ad_groups
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
      values (${orgId}, ${profileId}, ${adGroupId}, 'SP', 'Dev ad group', 'enabled', ${campaignId}, 0.8)
      on conflict (profile_id, amazon_id) do update set synced_at = now()
    `;

    for (const [index, keyword] of KEYWORDS.entries()) {
      await handle.sql`
        insert into public.keywords
          (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
           keyword_text, match_type, bid)
        values (${orgId}, ${profileId}, ${`${amazonProfileId}-kw${index + 1}`}, 'SP', ${keyword},
                'enabled', ${campaignId}, ${adGroupId}, ${keyword}, 'exact', ${0.5 + index * 0.15})
        on conflict (profile_id, amazon_id) do update set synced_at = now()
      `;
    }
  }
}

interface FactTotals {
  target: number;
  searchTerm: number;
  profile: number;
}

async function seedFacts(
  handle: DbHandle,
  orgId: string,
  profiles: Map<string, string>,
  days: number,
): Promise<FactTotals> {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  await ensureFactPartitions(handle, start, Math.ceil(days / 28) + 1);

  const totals: FactTotals = { target: 0, searchTerm: 0, profile: 0 };

  for (const [amazonProfileId, profileId] of profiles) {
    const currency = PROFILES.find((p) => p.amazonProfileId === amazonProfileId)?.currency ?? 'USD';
    const campaignId = `${amazonProfileId}-c1`;
    const adGroupId = `${amazonProfileId}-ag1`;
    const random = lcg(amazonProfileId.length * 7919);

    const targets: NewSpTargetFact[] = [];
    const searchTerms: NewSearchTermFact[] = [];
    const profileFacts: NewProfileFact[] = [];

    for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
      const day = new Date(start);
      day.setUTCDate(day.getUTCDate() + dayOffset);
      const date = isoDate(day);

      let dayImpressions = 0;
      let dayClicks = 0;
      let dayCost = 0;
      let daySales = 0;
      let dayPurchases = 0;

      for (const [index, keyword] of KEYWORDS.entries()) {
        const impressions = Math.round(200 + random() * 1800);
        const clicks = Math.round(impressions * (0.002 + random() * 0.01));
        const cost = round2(clicks * (0.4 + random() * 0.9));
        const purchases = Math.round(clicks * (random() * 0.18));
        const sales = round2(purchases * (18 + random() * 22));

        targets.push({
          orgId,
          profileId,
          date,
          adProduct: 'SP',
          campaignId,
          adGroupId,
          targetId: `${amazonProfileId}-kw${index + 1}`,
          targetKind: 'keyword',
          matchType: 'exact',
          impressions,
          clicks,
          cost,
          purchases1d: Math.round(purchases * 0.6),
          purchases7d: purchases,
          purchases14d: purchases,
          purchases30d: purchases,
          sales1d: round2(sales * 0.6),
          sales7d: sales,
          sales14d: sales,
          sales30d: sales,
          unitsSold7d: purchases,
          topOfSearchImpressionShare: round6(random() * 0.4),
        });

        searchTerms.push({
          orgId,
          profileId,
          date,
          adProduct: 'SP',
          campaignId,
          adGroupId,
          targetId: `${amazonProfileId}-kw${index + 1}`,
          searchTerm: `${keyword} online`,
          matchType: 'exact',
          impressions: Math.round(impressions * 0.7),
          clicks: Math.round(clicks * 0.7),
          cost: round2(cost * 0.7),
          purchases7d: Math.round(purchases * 0.7),
          sales7d: round2(sales * 0.7),
          unitsSold7d: Math.round(purchases * 0.7),
        });

        dayImpressions += impressions;
        dayClicks += clicks;
        dayCost = round2(dayCost + cost);
        daySales = round2(daySales + sales);
        dayPurchases += purchases;
      }

      profileFacts.push({
        orgId,
        profileId,
        date,
        currencyCode: currency,
        impressions: dayImpressions,
        clicks: dayClicks,
        cost: dayCost,
        purchases7d: dayPurchases,
        sales7d: daySales,
        unitsSold7d: dayPurchases,
        // Today's numbers are still attributing. The dashboard must show that.
        provisional: date === isoDate(today),
      });
    }

    totals.target += (await upsertSpTargetFacts(handle, targets)).written;
    totals.searchTerm += (await upsertSearchTermFacts(handle, searchTerms)).written;
    totals.profile += (await upsertProfileFacts(handle, profileFacts)).written;
  }

  return totals;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const force = argv.includes('--force');
  const daysIndex = argv.indexOf('--days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1] ?? 60) : 60;
  if (!Number.isInteger(days) || days < 1 || days > 400) {
    throw new Error('--days must be an integer between 1 and 400');
  }

  const connectionString = connectionStringFromEnv();
  if (!isLocal(connectionString) && !force) {
    throw new Error(
      'DATABASE_URL does not point at localhost. Synthetic data does not belong in a ' +
        'shared database; pass --force if you are certain.',
    );
  }

  const handle = createDb({ connectionString, max: 4 });
  try {
    const { orgId } = await ensureOrg(handle);
    const profiles = await ensureProfiles(handle, orgId);
    await ensureMirror(handle, orgId, profiles);
    const totals = await seedFacts(handle, orgId, profiles, days);

    console.log(
      `seeded org ${ORG_SLUG}: ${profiles.size} profiles, ${days} days, ` +
        `${totals.target} target facts, ${totals.searchTerm} search-term facts, ` +
        `${totals.profile} profile facts`,
    );
  } finally {
    await handle.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { ORG_SLUG, DEV_USER_ID };
