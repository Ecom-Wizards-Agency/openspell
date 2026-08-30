import {
  connectionStringFromEnv,
  createDb,
} from '@wizard-ads/db';
import {
  CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV,
  parseCreativeSyncProfileAllowlist,
} from './deployment-role.js';
import { workerRevisionFromEnv } from './config.js';
import {
  runCreativePilotPreflight,
  type CreativePilotPreflightResult,
} from './creative-pilot-preflight.js';

export interface CreativePilotPreflightCliArgs {
  healthUrl: URL;
  expectedRevision: string;
}

const USAGE = 'usage: creative:preflight --health-url <http(s)://host/healthz> --expected-revision <git-sha>';

export function parseCreativePilotPreflightArgs(
  args: readonly string[],
): CreativePilotPreflightCliArgs {
  if (args.length !== 4) throw new Error(USAGE);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !['--health-url', '--expected-revision'].includes(name) || !value) {
      throw new Error(USAGE);
    }
    if (values.has(name)) throw new Error(USAGE);
    values.set(name, value);
  }
  const rawHealthUrl = values.get('--health-url');
  const rawRevision = values.get('--expected-revision');
  if (!rawHealthUrl || !rawRevision) throw new Error(USAGE);
  let healthUrl: URL;
  try {
    healthUrl = new URL(rawHealthUrl);
  } catch {
    throw new Error(USAGE);
  }
  if (
    !['http:', 'https:'].includes(healthUrl.protocol) ||
    healthUrl.pathname !== '/healthz' ||
    healthUrl.username !== '' ||
    healthUrl.password !== '' ||
    healthUrl.search !== '' ||
    healthUrl.hash !== ''
  ) throw new Error(USAGE);
  let expectedRevision: string;
  try {
    expectedRevision = workerRevisionFromEnv({ OPENSPELL_WORKER_REVISION: rawRevision });
  } catch {
    throw new Error(USAGE);
  }
  if (expectedRevision === 'unknown') throw new Error(USAGE);
  return { healthUrl, expectedRevision };
}

export async function runCreativePilotPreflightCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
  fetchHealth: typeof fetch = fetch,
): Promise<CreativePilotPreflightResult> {
  const parsed = parseCreativePilotPreflightArgs(args);
  const profileIds = parseCreativeSyncProfileAllowlist(
    env[CREATIVE_SYNC_PROFILE_ALLOWLIST_ENV],
  );
  const response = await fetchHealth(parsed.healthUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('worker health is not ready');
  let workerHealth: unknown;
  try {
    workerHealth = await response.json();
  } catch {
    throw new Error('worker health is malformed');
  }
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1 });
  try {
    const result = await runCreativePilotPreflight({
      handle,
      profileIds,
      expectedRevision: parsed.expectedRevision,
      workerHealth,
    });
    write(JSON.stringify(result));
    return result;
  } finally {
    await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCreativePilotPreflightCli(process.argv.slice(2)).then((result) => {
    if (!result.ready) process.exitCode = 2;
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Creative pilot preflight failed');
    process.exitCode = 1;
  });
}
