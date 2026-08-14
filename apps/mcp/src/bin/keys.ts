/**
 * Key management for an operator: `pnpm --filter @wizard-ads/mcp keys <command>`.
 *
 *   keys issue --org <slug> --label "crosscheck QA" [--profiles <id,id>] [--days 90]
 *   keys list  --org <slug>
 *   keys revoke --id <key id>
 *
 * The token is printed once, to stdout, and never stored in plaintext anywhere.
 * If it is lost, issue another and revoke the first; there is no recovery, by
 * design.
 */
import { connectionStringFromEnv, createDb } from '@wizard-ads/db';
import { issueApiKey, listApiKeys, revokeApiKey } from '../keys.js';

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
      if (!slug || !label) throw new Error('usage: keys issue --org <slug> --label <label>');

      const rows = await handle.sql<{ id: string }[]>`
        select id from public.orgs where slug = ${slug}
      `;
      const org = rows[0];
      if (!org) throw new Error(`no org with slug "${slug}"`);

      const profiles = flag(argv, 'profiles');
      const days = flag(argv, 'days');
      const issued = await issueApiKey(handle, {
        orgId: org.id,
        label,
        profileIds: profiles ? profiles.split(',').map((value) => value.trim()) : null,
        expiresAt: days ? new Date(Date.now() + Number(days) * 86_400_000) : null,
      });

      console.log(`key id : ${issued.record.id}`);
      console.log(`scope  : ${issued.record.scope}`);
      console.log(
        `profiles: ${issued.record.profileIds ? issued.record.profileIds.join(', ') : 'all in org'}`,
      );
      console.log(`expires: ${issued.record.expiresAt?.toISOString() ?? 'never'}`);
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
