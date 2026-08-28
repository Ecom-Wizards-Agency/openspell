/**
 * Key management for an operator: `pnpm --filter @wizard-ads/mcp keys <command>`.
 *
 *   keys issue --org <slug> --label "crosscheck QA" --profiles <id,id> [--days 30]
 *   keys list  --org <slug>
 *   keys revoke --id <key id>
 *
 * The token is printed once, to stdout, and never stored in plaintext anywhere.
 * If it is lost, issue another and revoke the first; there is no recovery, by
 * design.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import {
  DEFAULT_API_KEY_LIFETIME_DAYS,
  issueApiKey,
  listApiKeys,
  MAX_API_KEY_LIFETIME_DAYS,
  revokeApiKey,
} from '../keys.js';

const DAY_MS = 86_400_000;

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const handle = createDb({ connectionString: connectionStringFromEnv(), max: 2 });

  try {
    if (command === 'issue') {
      const slug = flag(argv, 'org');
      const label = flag(argv, 'label');
      const profiles = flag(argv, 'profiles');
      if (!slug || !label || !profiles) {
        throw new Error(
          'usage: keys issue --org <slug> --label <label> --profiles <id,id> [--days 30]',
        );
      }

      const daysFlag = flag(argv, 'days');
      const days = daysFlag === undefined ? DEFAULT_API_KEY_LIFETIME_DAYS : Number(daysFlag);
      if (!Number.isInteger(days) || days < 1 || days > MAX_API_KEY_LIFETIME_DAYS) {
        throw new Error(`--days must be a whole number from 1 to ${MAX_API_KEY_LIFETIME_DAYS}`);
      }

      const rows = await handle.sql<{ id: string }[]>`
        select id from public.orgs where slug = ${slug}
      `;
      const org = rows[0];
      if (!org) throw new Error(`no org with slug "${slug}"`);

      const issued = await issueApiKey(handle, {
        orgId: org.id,
        label,
        profileIds: profiles.split(',').map((value) => value.trim()),
        expiresAt: new Date(Date.now() + days * DAY_MS),
      });

      console.log(`key id : ${issued.record.id}`);
      console.log(`scope  : ${issued.record.scope}`);
      console.log(
        `profiles: ${issued.record.profileIds?.join(', ') ?? 'invalid legacy scope'}`,
      );
      console.log(`expires: ${issued.record.expiresAt?.toISOString() ?? 'invalid legacy expiry'}`);
      console.log('');
      console.log('token (shown once, store it in the client config, never in this repo):');
      console.log(issued.token);
      return;
    }

    if (command === 'list') {
      const slug = flag(argv, 'org');
      if (!slug) throw new Error('usage: keys list --org <slug>');
      const rows = await handle.sql<{ id: string }[]>`
        select id from public.orgs where slug = ${slug}
      `;
      const org = rows[0];
      if (!org) throw new Error(`no org with slug "${slug}"`);

      for (const key of await listApiKeys(handle, org.id)) {
        const state = key.revokedAt ? 'revoked' : key.expiresAt && key.expiresAt < new Date() ? 'expired' : 'active';
        console.log(
          `${key.id}  ${key.keyPrefix}…  ${state.padEnd(8)}  ${key.scope}  ` +
            `last used ${key.lastUsedAt?.toISOString() ?? 'never'}  ${key.label}`,
        );
      }
      return;
    }

    if (command === 'revoke') {
      const id = flag(argv, 'id');
      if (!id) throw new Error('usage: keys revoke --id <key id>');
      console.log((await revokeApiKey(handle, id)) ? 'revoked' : 'no such key');
      return;
    }

    throw new Error('usage: keys <issue|list|revoke> [options]');
  } finally {
    await handle.close();
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
