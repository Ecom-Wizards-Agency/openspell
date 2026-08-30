import { createDb, connectionStringFromEnv } from '@wizard-ads/db';
import { requeueMarketingStreamBlockedProfile } from './marketing-stream-normalize.js';

export interface MarketingStreamRecoveryCliArgs { orgId: string; profileId: string }
type RecoveryResult = Awaited<ReturnType<typeof requeueMarketingStreamBlockedProfile>>;

export function parseMarketingStreamRecoveryArgs(args: readonly string[]): MarketingStreamRecoveryCliArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !['--org-id', '--profile-id'].includes(name) || !value) {
      throw new Error('usage: stream:recover --org-id <uuid> --profile-id <uuid>');
    }
    values.set(name, value);
  }
  const orgId = values.get('--org-id');
  const profileId = values.get('--profile-id');
  if (!orgId || !profileId || values.size !== 2) {
    throw new Error('usage: stream:recover --org-id <uuid> --profile-id <uuid>');
  }
  return { orgId, profileId };
}

export async function runMarketingStreamRecoveryCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = console.log,
): Promise<void> {
  const input = parseMarketingStreamRecoveryArgs(args);
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1 });
  try {
    const result = await requeueMarketingStreamBlockedProfile({ handle, ...input });
    write(formatMarketingStreamRecoveryResult(input, result));
  } finally {
    await handle.close();
  }
}

export function formatMarketingStreamRecoveryResult(
  input: MarketingStreamRecoveryCliArgs,
  result: RecoveryResult,
): string {
  return JSON.stringify({ orgId: input.orgId, profileId: input.profileId, ...result });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMarketingStreamRecoveryCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Marketing Stream recovery failed');
    process.exitCode = 1;
  });
}
