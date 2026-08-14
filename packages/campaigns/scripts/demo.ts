/**
 * A campaign plan, end to end, from a committed fixture.
 *
 * Run it from the package directory:
 *
 *     pnpm demo                       # the default scenario
 *     pnpm demo ew_preset             # a named one
 *     pnpm demo --list                # what is available
 *     pnpm demo ew_preset --xlsx out.xlsx   # also write the workbook
 *
 * This is the only file in the package that touches a filesystem. The engine
 * itself is pure: it takes a config and `today` and returns a plan, which is
 * what makes the parity harness possible. Reading a fixture and writing a
 * workbook are a caller's job, and this script is the smallest possible
 * caller.
 *
 * It writes a file only when asked to, and even then the file is inert: every
 * campaign in it is paused. Creating campaigns through the Ads API is WP-14b.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCampaignPlan,
  preflight,
  summarizePlan,
  toBulkWorkbook,
  validateRows,
  planToRows,
  type CampaignBuildConfig,
} from '../src/index.js';

const GOLDEN = fileURLToPath(new URL('../../../fixtures/golden/campaigns.json', import.meta.url));

interface GoldenCase {
  name: string;
  input: { config: CampaignBuildConfig; today: string };
}

function loadCases(): GoldenCase[] {
  const file = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: GoldenCase[] };
  return file.cases;
}

function main(argv: readonly string[]): number {
  const cases = loadCases();
  const names = cases.map((c) => c.name.replace('generate:', ''));

  if (argv.includes('--list')) {
    console.log(`fixtures in ${GOLDEN}:`);
    for (const name of names) console.log(`  ${name}`);
    return 0;
  }

  const requested = argv.find((arg) => !arg.startsWith('--')) ?? 'ew_preset';
  const selected = cases[names.indexOf(requested)];
  if (selected === undefined) {
    console.error(`no fixture named '${requested}'. Try one of: ${names.join(', ')}`);
    return 1;
  }

  const { config, today } = selected.input;
  const checks = preflight(config, today);
  console.log(`${config.client} (${config.marketplace}) · fixture ${requested} · today ${today}\n`);
  for (const issue of checks.issues) console.log(`  [BLOCKS] ${issue}`);
  for (const note of checks.notes) console.log(`  [NOTE]   ${note}`);
  if (!checks.ready) {
    console.error('\nNOT READY: nothing generated.');
    return 1;
  }

  const plan = buildCampaignPlan(config, { today });
  const rows = planToRows(plan);
  const gates = validateRows(rows, today);

  console.log(`\n${plan.campaigns.length} campaign(s), ${rows.length} bulk row(s):\n`);
  for (const line of summarizePlan(plan)) console.log(`  ${line}`);

  const budget = plan.campaigns.reduce((total, campaign) => total + campaign.dailyBudget, 0);
  const enabled = plan.campaigns.filter((campaign) => campaign.state === 'enabled').length;
  console.log(`\n  Combined daily budget: ${budget.toFixed(2)}`);
  console.log(`  State: ${enabled} enabled / ${plan.campaigns.length - enabled} paused`);

  for (const warn of gates.warns) console.log(`  [WARN]   ${warn}`);
  for (const fail of gates.fails) console.log(`  [FAIL]   ${fail}`);
  console.log(`\n  QA gates: ${gates.pass ? 'PASS' : 'FAIL'} (${gates.warns.length} warning(s))`);

  const xlsxAt = argv.indexOf('--xlsx');
  if (xlsxAt !== -1) {
    const workbook = toBulkWorkbook(plan);
    const path = argv[xlsxAt + 1] ?? workbook.filename;
    writeFileSync(path, workbook.bytes);
    console.log(`\n  Wrote ${path} (${workbook.bytes.length} bytes). Upload is an operator action.`);
  }

  return gates.pass ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
