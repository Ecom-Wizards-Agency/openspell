/**
 * The end-to-end world: ports, ids, and the one file the specs read them from.
 *
 * Everything is deterministic. The database name is fixed rather than random,
 * so a run interrupted with ctrl-C leaves one database behind that the next run
 * drops, instead of a growing pile of them. The three user ids are constants
 * for the same reason a fixture is: a test that has to discover its own actors
 * is testing discovery.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Written by global setup, read by every spec. Inside node_modules: never committed. */
export const STATE_FILE = resolve(WEB_ROOT, 'node_modules/.cache/wizard-ads-e2e.json');

export const APP_PORT = Number(process.env['WIZARD_ADS_E2E_PORT'] ?? 3987);
export const MOCK_PORT = Number(process.env['WIZARD_ADS_E2E_MOCK_PORT'] ?? 3988);
export const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

export const DATABASE_NAME = 'wizard_ads_e2e';

/** Long enough to be a real HMAC key, and obviously not a secret. */
export const STATE_KEY = 'wizard-ads-e2e-state-key-0123456789abcdef';

export const USERS = {
  admin: '10000000-0000-4000-8000-000000000001',
  analyst: '10000000-0000-4000-8000-000000000002',
  viewer: '10000000-0000-4000-8000-000000000003',
  outsider: '10000000-0000-4000-8000-000000000004',
} as const;

export type UserKey = keyof typeof USERS;

/** Profiles the mock Amazon grant returns, per region. FE is deliberately absent. */
export const GRANT = { na: 2, eu: 3 } as const;
export const GRANT_TOTAL = GRANT.na + GRANT.eu;

export interface E2EState {
  connectionString: string;
  orgId: string;
  otherOrgId: string;
  fixtureProfileId: string;
}

export async function writeState(state: E2EState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export async function readState(): Promise<E2EState> {
  return JSON.parse(await readFile(STATE_FILE, 'utf8')) as E2EState;
}
