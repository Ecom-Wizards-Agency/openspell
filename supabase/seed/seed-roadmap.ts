/**
 * Seed the initial roadmap.
 *
 * A roadmap page that opens empty teaches the team that the roadmap is empty,
 * and they stop looking. These are the eleven things already decided to be
 * coming, filed as ordinary feature requests so they live in the same tracker,
 * carry the same votes and move through the same statuses as anything a
 * teammate files tomorrow. Nothing about them is special-cased.
 *
 * Operator-run and idempotent: an item is identified by its title within the
 * org, so re-running adds what is missing and touches nothing else. That is
 * what makes it safe to run again after editing the list.
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
}

/**
 * The list, in the order it was decided. Order is not rank: the board sorts by
 * votes, which is the point of having votes.
 */
export const ROADMAP_ITEMS: readonly RoadmapSeedItem[] = [
  {
    title: 'AMC integration (SQL workbench, query library, audiences)',
    body: 'See docs/workpackages/WP-16-amc.md.',
  },
  {
    title: 'SP-API: total sales, TACOS everywhere + SUPA (SQP × PPC analyzer)',
    body:
      'Total sales from SP-API make TACOS a real column rather than an estimate, and SUPA ' +
      'crosses SQP against our own PPC rows.',
  },
  {
    title: 'DataDive organic rank on keyword rows',
    body: 'Organic rank next to the bid, so a rank decision and a bid decision are one screen.',
  },
  {
    title: 'Keepa BSR competitor-proximity alerts',
    body: 'Alert when a competitor closes on us in BSR, not a month later in a report.',
  },
  {
    title: 'Creative Hub (asset-level SP/SB/SD creative table, winner fan-out)',
    body: 'Performance per creative asset across ad products, and one click to fan a winner out.',
  },
  {
    title: 'Off-Amazon placement control + leakage report',
    body: 'Where the off-Amazon spend went, and the control to stop it going there.',
  },
  {
    title: 'Dayparting via Marketing Stream',
    body: 'Hourly data from Marketing Stream, then bid and budget schedules built on it.',
  },
  {
    title: 'Staged-apply write engine (bids/placements/negatives from the tool)',
    body: 'Snapshot, apply in batches, revert by batch. Gated until the crosscheck exit criterion is met.',
  },
  {
    title: 'Harvesting with auto-created destination campaigns',
    body: 'Promote a proven search term without hand-building the campaign it lands in.',
  },
  {
    title: 'Campaign creation via API (paused by default)',
    body: 'Build campaigns from a brief in the tool; nothing starts spending without a human enabling it.',
  },
  {
    title: 'Daily headless AI analyst with Slack digest',
    body: 'A read-only analyst pass every morning, posting what changed and what it means.',
  },
  {
    title:
      'Pre-installed AI skills library (downloadable skills + Connect Claude page with MCP key issuance)',
    body: 'See docs/workpackages/WP-17-skills-library.md.',
  },
];

export interface RoadmapSeedResult {
  orgId: string;
  offered: number;
  created: number;
  alreadyPresent: number;
  authorId: string | null;
}

export type RoadmapSeedHandle = Pick<DbHandle, 'sql'>;

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
 * Rule 45: items offered against items created against items already present,
 * and the three have to reconcile or the function throws rather than reporting
 * a success it did not verify.
 */
export async function seedRoadmap(
  handle: RoadmapSeedHandle,
  options: { orgSlug?: string; orgId?: string; authorId?: string; dryRun?: boolean },
): Promise<RoadmapSeedResult> {
  const orgId = options.orgId ?? (await resolveOrg(handle, options.orgSlug ?? ''));
  const authorId = await resolveAuthor(handle, orgId, options.authorId);

  let created = 0;
  let alreadyPresent = 0;

  for (const item of ROADMAP_ITEMS) {
    const existing = await handle.sql<{ id: string }[]>`
      select id from public.feedback_items
       where org_id = ${orgId} and title = ${item.title}
    `;
    if (existing.length > 0) {
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

  if (created + alreadyPresent !== ROADMAP_ITEMS.length) {
    throw new Error(
      `roadmap seed does not reconcile: offered ${ROADMAP_ITEMS.length}, ` +
        `created ${created}, already present ${alreadyPresent}`,
    );
  }

  return { orgId, offered: ROADMAP_ITEMS.length, created, alreadyPresent, authorId };
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
        `${result.created} created, ${result.alreadyPresent} already present, ` +
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
