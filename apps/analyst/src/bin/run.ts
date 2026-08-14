/**
 * Entry point: `pnpm --filter @wizard-ads/analyst start [-- --dry-run]`.
 *
 * Meant to run from cron on the always-on Mac mini (docs/VISION.md §4). It reads
 * its configuration from the environment, makes one pass, prints each digest to
 * stdout, and exits. Slack is deliberately not wired here: the operator's
 * downstream step takes the printed digest and posts it through the guarded
 * Wizards AI helper, so this process holds no Slack credential.
 *
 * Flags override the environment for an ad-hoc run:
 *   --dry-run            analyze and print, write no insight
 *   --lookback <days>    trailing window for the headline metrics
 *   --as-of <YYYY-MM-DD> report on a specific day instead of the latest fact day
 */
import { createDb } from '@wizard-ads/db';
import { runDailyAnalyst } from '../analyst.js';
import { configFromEnv } from '../config.js';
import type { AnalystConfig } from '../config.js';
import { connectMcp } from '../mcp-client.js';

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function applyArgs(config: AnalystConfig, argv: readonly string[]): AnalystConfig {
  const lookback = flag(argv, 'lookback');
  const asOf = flag(argv, 'as-of');
  return {
    ...config,
    dryRun: config.dryRun || argv.includes('--dry-run'),
    ...(lookback ? { lookbackDays: Number(lookback) } : {}),
    ...(asOf ? { asOf } : {}),
  };
}

async function main(argv: readonly string[]): Promise<void> {
  const config = applyArgs(configFromEnv(), argv);
  const mcp = await connectMcp({ url: config.mcpUrl, token: config.mcpToken });
  const handle = createDb({ connectionString: config.databaseUrl, max: 2 });

  try {
    const run = await runDailyAnalyst({ mcp, handle, config });

    console.log(
      `# Analyst run ${run.runDate}${run.dryRun ? ' (dry run — nothing written)' : ''}\n` +
        `${run.profilesAnalyzed}/${run.profilesConsidered} profiles analyzed, ` +
        `${run.insightsWritten} insight${run.insightsWritten === 1 ? '' : 's'} written.\n`,
    );
    for (const result of run.results) {
      if (result.error) {
        console.error(`\n[skipped ${result.accountName}] ${result.error}`);
        continue;
      }
      console.log(`\n${result.markdown}`);
      if (result.insightId) console.log(`\n_insight ${result.insightId}_`);
    }

    const failures = run.results.filter((result) => result.error).length;
    if (failures > 0) process.exitCode = 1;
  } finally {
    await mcp.close();
    await handle.close();
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
