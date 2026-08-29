/**
 * Seed the initial roadmap.
 *
 * A roadmap page that opens empty teaches the team that the roadmap is empty,
 * and they stop looking. These are the eleven things already decided to be
 * coming, filed as ordinary feature requests so they live in the same tracker,
 * carry the same votes and move through the same statuses as anything a
 * teammate files tomorrow. Nothing about them is special-cased.
 *
 * Operator-run and idempotent: an item is identified by its canonical title or
 * an explicit legacy alias within the org. Re-running creates missing cards and
 * refreshes only planned feature cards whose manifest copy changed. It never
 * moves an in-progress or completed card back to Planned.
 *
 * Usage:
 *
 *   pnpm --filter @wizard-ads/db seed:roadmap -- --org <slug> [options]
 *
 *   --org <slug>      which org in `orgs.slug` receives the items
 *   --author <uuid>   who to record as the author; defaults to the org's first
 *                     owner, and to nobody when the org has none
 *   --dry-run         report what would be written, write nothing
 *
 * The connection comes from DATABASE_URL and must be a service-role or direct
 * superuser connection.
 */
import { connectionStringFromEnv, createDb } from '../../packages/db/src/index.js';
import type { DbHandle } from '../../packages/db/src/index.js';

export interface RoadmapSeedItem {
  title: string;
  body: string;
  /** Earlier seed titles that should be upgraded, never duplicated. */
  aliases?: readonly string[];
}

/**
 * The list, in the order it was decided. Order is not rank: the board sorts by
 * votes, which is the point of having votes.
 */
export const ROADMAP_ITEMS: readonly RoadmapSeedItem[] = [
  {
    title: 'AMC integration (SQL workbench, query library, audiences)',
    body:
      'Value: answer audience and path-to-purchase questions that standard ads reports cannot. ' +
      'Prerequisite: eligible accounts, approved query templates, storage, and privacy review. ' +
      'Deferred because: those account and data-governance prerequisites are not yet verified. See docs/workpackages/WP-16-amc.md.',
  },
  {
    title: 'SQP Query Intelligence from SP-API Brand Analytics',
    aliases: ['SP-API: total sales, TACOS everywhere + SUPA (SQP × PPC analyzer)'],
    body:
      'Value: separate Own Brand, Competitor, Core, Generic Head, Excluded, and Needs Review intent and join weekly SQP with PPC without duplicating spend. ' +
      'Prerequisite: verified weekly SP-API report ingestion, human-approved vocabulary, and synthetic parity fixtures. ' +
      'Deferred because: contracts and the pure client exist, but live ingestion and count parity do not.',
  },
  {
    title: 'Four-axis keyword cockpit',
    aliases: ['DataDive organic rank on keyword rows'],
    body:
      'Value: place organic rank, Top-of-Search impression share, SQP impression share, and SQP purchase share on one decision surface. ' +
      'Prerequisite: like-for-like keyword/week joins with source and coverage labels. ' +
      'Deferred because: the component sources exist at different grains and have not passed joined-data parity.',
  },
  {
    title: 'Keepa BSR competitor-proximity alerts',
    body:
      'Value: warn operators when a competitor closes a meaningful BSR gap before the change disappears into a monthly report. ' +
      'Prerequisite: stable competitor mapping and alert-noise validation. ' +
      'Deferred because: Keepa synchronization exists, but alert quality is not yet proven.',
  },
  {
    title: 'Sponsored Brands Video Creative Performance v1',
    aliases: ['Creative Hub (asset-level SP/SB/SD creative table, winner fan-out)'],
    body:
      'Value: aggregate one Amazon Asset ID across ads, campaigns, ad groups, and placements while retaining drill-down and unsupported-attribution states. ' +
      'Prerequisite: authoritative ad-to-creative-to-asset mappings and ad-level reporting count parity. ' +
      'Deferred because: storage contracts exist, but live ingestion and Asset-ID crosschecks do not.',
  },
  {
    title: 'Creative Performance beyond Sponsored Brands Video',
    body:
      'Value: extend verified asset-level performance to additional Sponsored Brands, Sponsored Products, and Sponsored Display formats. ' +
      'Prerequisite: Sponsored Brands Video v1 must pass authoritative Asset-ID and placement crosschecks first. ' +
      'Deferred because: widening attribution before the first format is proven would silently combine incompatible creative grains.',
  },
  {
    title: 'Off-Amazon placement control + leakage report',
    body:
      'Value: show where off-Amazon spend went and propose controls for avoidable leakage. ' +
      'Prerequisite: placement-level evidence and the global Amazon write gate. ' +
      'Deferred because: the current read-only product may export proposals but cannot apply placement controls.',
  },
  {
    title: 'Automatic dayparting execution',
    aliases: ['Dayparting via Marketing Stream'],
    body:
      'Value: execute verified hourly bid and budget schedules after a first dry run. ' +
      'Prerequisite: idempotent Marketing Stream ingestion, settled-hour evidence, confidence validation, and the global write gate. ' +
      'Deferred because: Dayparting v0.5 remains proposal/export only and automatic Amazon changes are prohibited.',
  },
  {
    title: 'Direct Amazon apply and rollback after the crosscheck/write gate',
    aliases: ['Staged-apply write engine (bids/placements/negatives from the tool)'],
    body:
      'Value: apply approved batches with before/after snapshots and conflict-safe rollback. ' +
      'Prerequisite: sustained crosscheck parity, least-privilege write authorization, staged rollout, and operator approval. ' +
      'Deferred because: Wizard Ads v1 is intentionally analyze, preview, and export only.',
  },
  {
    title: 'Harvesting with auto-created destination campaigns',
    body:
      'Value: turn a proven Discovery search term into a reviewed Profit or Rank destination proposal without rebuilding its context by hand. ' +
      'Prerequisite: contextual routing policy, guided campaign generation, warnings, and ad-group negative review. ' +
      'Deferred because: automated harvesting still needs query-classification and destination parity.',
  },
  {
    title: 'Campaign creation via API (paused by default)',
    body:
      'Value: convert an approved guided campaign plan into paused Amazon entities. ' +
      'Prerequisite: creation parity, idempotency, staged apply, and the global write gate. ' +
      'Deferred because: the current guided builder exports a manual Bulk Operations file and never writes to Amazon.',
  },
  {
    title: 'Credible experiment assignment and randomization',
    aliases: ['Experiment tracking (A/B tests: spend pushes, creatives, listings, price)'],
    body:
      'Value: compare tagged tests with valid control/test or multi-variant assignment instead of relying only on before/after timing. ' +
      'Prerequisite: exposure tracking, sample-size rules, guardrails, and reproducible assignment. ' +
      'Deferred because: experiment records and tags exist, but credible assignment and causal interpretation do not.',
  },
  {
    title: 'Account-specific conversion-delay modelling',
    body:
      'Value: show how much eventual orders and sales are normally visible after each event-date age so fresh days are not judged as settled. ' +
      'Prerequisite: enough superseded attribution observations and settled cohorts to estimate confidence. ' +
      'Deferred because: observations are being retained now, but no model may influence recommendations before parity and stability gates pass.',
  },
  {
    title: 'Historical coverage beyond Amazon authoritative availability',
    body:
      'Value: retain a longer decision baseline where a lawful, attributable archive is available. ' +
      'Prerequisite: a verified source with explicit provenance, retention rights, and overlap parity against Amazon. ' +
      'Deferred because: Wizard Ads will not claim unsupported lifetime history or treat secondary imports as authoritative.',
  },
  {
    title: 'Validated unified-report and Marketing Stream historical bootstrap',
    body:
      'Value: start new profiles with the maximum authoritative history each exact report dimension supports. ' +
      'Prerequisite: capability detection, overlapping dual-run parity, request reuse, throttling, and source-to-output counts. ' +
      'Deferred because: bounded planners and storage exist, but a unified or stream bootstrap is not authoritative until live parity is proven.',
  },
  {
    title: 'Time Machine v2: conflict-safe reversion exports',
    body:
      'Value: preview the exact inverse of an exported batch and produce a reversion file only when synchronized current state still matches the expected applied value. ' +
      'Prerequisite: recommendation history, synchronized observations, and conflict detection. ' +
      'Deferred because: Time Machine v1 records history but cannot yet prove or safely invert observed state.',
  },
];

export interface RoadmapSeedResult {
  orgId: string;
  offered: number;
  created: number;
  updated: number;
  alreadyPresent: number;
  authorId: string | null;
}

export type RoadmapSeedHandle = Pick<DbHandle, 'sql'>;

interface ExistingRoadmapItem {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
}

async function findExisting(
  handle: RoadmapSeedHandle,
  orgId: string,
  item: RoadmapSeedItem,
): Promise<ExistingRoadmapItem | null> {
  const matches: ExistingRoadmapItem[] = [];
  for (const title of [item.title, ...(item.aliases ?? [])]) {
    const rows = await handle.sql<ExistingRoadmapItem[]>`
      select id, title, body, type, status
        from public.feedback_items
       where org_id = ${orgId} and title = ${title}
    `;
    matches.push(...rows);
  }
  if (matches.length > 1) {
    throw new Error(`roadmap item '${item.title}' matches ${matches.length} existing rows`);
  }
  return matches[0] ?? null;
}

async function resolveOrg(handle: RoadmapSeedHandle, slug: string): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    select id from public.orgs where slug = ${slug}
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error(`no org with slug '${slug}'`);
  return id;
}

async function resolveAuthor(
  handle: RoadmapSeedHandle,
  orgId: string,
  requested: string | undefined,
): Promise<string | null> {
  if (requested) {
    const rows = await handle.sql<{ user_id: string }[]>`
      select user_id from public.org_members
       where org_id = ${orgId} and user_id = ${requested}
    `;
    const found = rows[0]?.user_id;
    if (!found) throw new Error(`user ${requested} is not a member of this org`);
    return found;
  }
  // The org's first owner, by seniority of membership. An org with no owner is
  // possible in a fresh database, and an unattributed item is better than a
  // failed seed.
  const rows = await handle.sql<{ user_id: string }[]>`
    select user_id from public.org_members
     where org_id = ${orgId} and role = 'owner'
     order by created_at, user_id
     limit 1
  `;
  return rows[0]?.user_id ?? null;
}

/**
 * Write the missing items and report the counts.
 *
 * Rule 45: items offered against items created, updated, and already present;
 * every outcome must reconcile or the function throws rather than reporting a
 * success it did not verify.
 */
export async function seedRoadmap(
  handle: RoadmapSeedHandle,
  options: { orgSlug?: string; orgId?: string; authorId?: string; dryRun?: boolean },
): Promise<RoadmapSeedResult> {
  const orgId = options.orgId ?? (await resolveOrg(handle, options.orgSlug ?? ''));
  const authorId = await resolveAuthor(handle, orgId, options.authorId);

  let created = 0;
  let updated = 0;
  let alreadyPresent = 0;

  for (const item of ROADMAP_ITEMS) {
    const existing = await findExisting(handle, orgId, item);
    if (existing !== null) {
      const needsUpdate = existing.type === 'feature'
        && existing.status === 'planned'
        && (existing.title !== item.title || existing.body !== item.body);
      if (needsUpdate) {
        if (!options.dryRun) {
          const rows = await handle.sql<{ id: string }[]>`
            update public.feedback_items
               set title = ${item.title}, body = ${item.body}, updated_at = now()
             where id = ${existing.id} and org_id = ${orgId}
            returning id
          `;
          if (rows.length !== 1) throw new Error(`updating '${item.title}' wrote no row`);
        }
        updated += 1;
        continue;
      }
      alreadyPresent += 1;
      continue;
    }
    if (options.dryRun) {
      created += 1;
      continue;
    }
    const inserted = await handle.sql<{ id: string }[]>`
      insert into public.feedback_items
        (org_id, author_id, type, title, body, status, page_context)
      values (
        ${orgId}, ${authorId}, 'feature', ${item.title}, ${item.body}, 'planned',
        ${JSON.stringify({ actorType: 'seed', route: '/roadmap' })}::text::jsonb
      )
      returning id
    `;
    if (inserted.length !== 1) throw new Error(`seeding '${item.title}' wrote no row`);
    created += 1;
  }

  if (created + updated + alreadyPresent !== ROADMAP_ITEMS.length) {
    throw new Error(
      `roadmap seed does not reconcile: offered ${ROADMAP_ITEMS.length}, ` +
        `created ${created}, updated ${updated}, already present ${alreadyPresent}`,
    );
  }

  return { orgId, offered: ROADMAP_ITEMS.length, created, updated, alreadyPresent, authorId };
}

interface Options {
  org: string;
  author?: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }
  const org = args.get('org');
  if (typeof org !== 'string') throw new Error('--org <slug> is required');
  const author = args.get('author');
  return {
    org,
    ...(typeof author === 'string' ? { author } : {}),
    dryRun: args.get('dry-run') === true,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const handle = createDb({ connectionString: connectionStringFromEnv(), max: 2 });
  try {
    const result = await seedRoadmap(handle, {
      orgSlug: options.org,
      ...(options.author ? { authorId: options.author } : {}),
      dryRun: options.dryRun,
    });
    console.log(
      `${options.dryRun ? 'would seed' : 'seeded'} roadmap for org ${options.org}: ` +
        `${result.created} created, ${result.updated} updated, ` +
        `${result.alreadyPresent} already present, ` +
        `${result.offered} offered` +
        `${result.authorId === null ? ' (no owner to attribute them to)' : ''}`,
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
