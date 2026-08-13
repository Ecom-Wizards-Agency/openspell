/**
 * Seed one tenant's doctrine document into `profile_strategy`.
 *
 * Operator-run, never automated, and deliberately the only path by which
 * threshold values enter the system. This repository is public: target ACOS,
 * change caps, search-volume bands, cooldowns and graduation ranks are the
 * agency's method and live as per-tenant database rows, sourced from a
 * gitignored local file. `_local/strategy.TEMPLATE.json` shows the shape with
 * every value replaced by a placeholder, and it is the only strategy file that
 * is ever committed.
 *
 * Usage:
 *
 *   pnpm --filter @wizard-ads/db seed:strategy -- --org <slug> [options]
 *
 *   --org <slug>        which org in `orgs.slug` receives the document
 *   --file <path>       default: _local/strategy.<slug>.json
 *   --profile <amazon>  seed one profile's override instead of the org default
 *   --dry-run           validate and report, write nothing
 *
 * The connection comes from DATABASE_URL and must be a service-role or direct
 * superuser connection; `profile_strategy` writes are owner/admin gated.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectionStringFromEnv, createDb, parseStrategyDocument, upsertStrategy } from '../../packages/db/src/index.js';
import type { DbHandle } from '../../packages/db/src/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface Options {
  org: string;
  file: string;
  profile?: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }

  const org = args.get('org');
  if (typeof org !== 'string') {
    throw new Error('--org <slug> is required (the slug in orgs.slug)');
  }
  const file = args.get('file');
  const profile = args.get('profile');

  return {
    org,
    file: typeof file === 'string' ? file : `${REPO_ROOT}_local/strategy.${org}.json`,
    profile: typeof profile === 'string' ? profile : undefined,
    dryRun: args.get('dry-run') === true,
  };
}

/**
 * Refuse a document that still contains template placeholders.
 *
 * The contract's own validation catches most of them (a `<fraction>` is not a
 * number), but a string-typed field would pass. Seeding the template instead of
 * the real file is the likeliest operator mistake here, and the failure is
 * silent by nature: a strategy full of placeholder text produces recommendations
 * that look fine and mean nothing.
 */
function findPlaceholders(value: unknown, path: string[] = []): string[] {
  if (typeof value === 'string') {
    return value.startsWith('<') && value.endsWith('>') ? [path.join('.')] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findPlaceholders(item, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      findPlaceholders(item, [...path, key]),
    );
  }
  return [];
}

async function resolveOrg(handle: DbHandle, slug: string): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`select id from public.orgs where slug = ${slug}`;
  const org = rows[0];
  if (!org) throw new Error(`no org with slug "${slug}". Create it before seeding a strategy.`);
  return org.id;
}

async function resolveProfile(
  handle: DbHandle,
  orgId: string,
  amazonProfileId: string,
): Promise<string> {
  const rows = await handle.sql<{ id: string }[]>`
    select id from public.ad_profiles
    where org_id = ${orgId} and amazon_profile_id = ${amazonProfileId}
  `;
  const profile = rows[0];
  if (!profile) {
    throw new Error(`org has no profile with amazon_profile_id "${amazonProfileId}"`);
  }
  return profile.id;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);

  let raw: string;
  try {
    raw = await readFile(options.file, 'utf8');
  } catch {
    throw new Error(
      `cannot read ${options.file}. Copy _local/strategy.TEMPLATE.json to ` +
        `_local/strategy.${options.org}.json and fill it in. It is gitignored on purpose.`,
    );
  }

  const document: unknown = JSON.parse(raw);
  const placeholders = findPlaceholders(document);
  if (placeholders.length > 0) {
    throw new Error(
      `${placeholders.length} unfilled placeholder(s) in ${options.file}: ` +
        `${placeholders.slice(0, 5).join(', ')}${placeholders.length > 5 ? ', ...' : ''}`,
    );
  }

  const strategy = parseStrategyDocument(document);
  const groups = Object.keys(strategy.opt_groups).length;
  console.log(
    `validated ${options.file}: schema ${strategy.schema}, ${groups} opt group(s)` +
      `${strategy.refreshed_at ? `, refreshed ${strategy.refreshed_at}` : ''}`,
  );

  if (options.dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  const handle = createDb({ connectionString: connectionStringFromEnv(), max: 1 });
  try {
    const orgId = await resolveOrg(handle, options.org);
    const profileId = options.profile
      ? await resolveProfile(handle, orgId, options.profile)
      : null;

    const row = await upsertStrategy(handle, {
      orgId,
      profileId,
      doc: strategy,
      source: 'import-strategy',
    });

    console.log(
      `wrote profile_strategy ${row.id} for org ${options.org}` +
        `${profileId ? ` profile ${options.profile}` : ' (org default)'}`,
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
