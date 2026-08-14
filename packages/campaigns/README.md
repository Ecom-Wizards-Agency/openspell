# @wizard-ads/campaigns

Generate complete Sponsored Products campaign structures from keyword research or a brief:
a typed plan, a bulk-upload workbook, and the QA gates that refuse to hand over a file
Amazon would reject.

This is WP-14a: the **engine and its exports**. Creating campaigns through the Ads API is
WP-14b, behind its own gate.

## Three properties hold everywhere in here

**Pure.** No filesystem, no network, no clock. `today` is an argument to every entry point.
That is not tidiness: it is what lets the parity suite replay the Python reference's goldens
against this port at all. `purity.test.ts` fails the build if a `Date.now()` appears.

**Paused by default.** A generated campaign's state comes from the config, and the config's
own default is `paused`. A file uploaded by accident spends nothing. Nothing in this package
can upload one.

**No doctrine.** Budgets, bids, search-volume bands and structure caps arrive in a
`TenantStrategy` at runtime. This repository is public; the numbers are not in it.

## What it generates

Five campaign types, each with its own fan-out rule:

| Type | Fans out to | Default match | Default bidding |
|---|---|---|---|
| `SKW` | one campaign per keyword | exact | fixed bid (down-only when the purpose is Shield) |
| `Halo` | one campaign for the whole long-tail list | exact | down only |
| `Phrase` | one campaign per discovery root | phrase | down only |
| `Auto` | one campaign, four targeting groups | auto | up and down |
| `PAT` | one campaign per target list | ASIN exact | down only (up and down when self-targeting) |

**BMM is not generated.** Operator decision, 2026-08-14: it does not work on our accounts.
The reference toolkit still builds broad-match-modifier campaigns and this port deliberately
does not; a spec asking for one is refused by name, with a message saying to use `Phrase`.
Nothing about *reading* BMM changed — an account can still be full of campaigns named that
way, and classifying them belongs to `packages/core`.

Bidding defaults are keyed by campaign **purpose**, not type, because purpose is the more
granular thing: a Shield campaign built on SKW takes down-only rather than the fixed bid its
type would otherwise get.

## Using it

```ts
import {
  buildCampaignPlan, preflight, validateRows, planToRows, toBulkWorkbook, toPlanJson,
} from '@wizard-ads/campaigns';

const checks = preflight(config, '2026-08-14');
if (!checks.ready) throw new Error(checks.issues.join('\n'));

const plan = buildCampaignPlan(config, { today: '2026-08-14' });
const gates = validateRows(planToRows(plan), '2026-08-14');

const workbook = toBulkWorkbook(plan);   // { filename, bytes, sheet }
const json = toPlanJson(plan);
```

From keyword research instead of a hand-written config:

```ts
import { specsFromRows, specDefaultsForBucket } from '@wizard-ads/campaigns';

const specs = specsFromRows(keywordRows, targetRows, { productName, sku })
  .map((spec) => ({ ...spec, ...specDefaultsForBucket(strategy, bucketOf(spec)) }));
```

Run the demo to see a plan end to end:

```bash
pnpm demo --list
pnpm demo ew_preset
pnpm demo ew_preset --xlsx /tmp/plan.xlsx
```

## The two gates

`preflight` reads a **config**: is it buildable, and is anything about it suspicious.
`validateRows` reads the **projected rows**: would this file upload, and would it do anything.

They run at different times on purpose. Preflight catches an operator's mistake before
anything is generated; the QA gates catch the projection's mistakes, which is where a
campaign quietly loses its Product Ad row and advertises nothing. A gate that read the plan
objects the generator just wrote could only find bugs the generator already knew about.

Both distinguish **fails** (block) from **notes** or **warns** (an operator decides). A
discovery campaign with no never-ever list is a note; a duplicate campaign name is a fail,
because Amazon rejects the file.

## Parity with the Python reference

`~/os/amazon-agent/tools/amazon-campaign-builder/` is read-only ground truth. Its logic was
ported; nothing was imported or copied.

`fixtures/generate/generate_campaign_goldens.py` runs the reference's own create-mode
scenarios plus the edge cases this port needs pinned, and writes four goldens:

| Golden | Pins |
|---|---|
| `campaigns.json` | plans, bulk rows, the workbook openpyxl wrote, and both gates' verdicts |
| `campaign-preflight.json` | every preflight issue and note string |
| `campaign-validate.json` | every QA-gate string, from hand-built row sets |
| `campaign-keywords.json` | bucketed keyword sections to campaign specs |

`src/parity.test.ts` replays all four. Regenerating is an operator step; CI replays the
committed goldens with no Python and no network:

```bash
WIZARD_ADS_CAMPAIGN_REFERENCE_TOOLS=<path to amazon-campaign-builder> \
  python3 fixtures/generate/generate_campaign_goldens.py
```

The goldens carry a `today`, because the reference reads the clock in three places (the
default start date, the `Date` naming slot, and the past-start-date gates). Regenerating on a
different day changes them, which is expected and visible in the diff.

## The workbook writer

`src/xlsx/` is a hand-rolled ZIP and worksheet writer, about 300 lines, with no dependency.
Three reasons, all pointing the same way: the engine stays pure (no `node:zlib`, nothing to
stub), the lockfile stays untouched while several packages are built in parallel, and the
reader that comes with it lets a test open the file it just wrote rather than trusting that
it wrote one.

Entries are STORED rather than deflated, and timestamps are fixed, so the same plan exports
byte-identical bytes every time and two exports can be diffed.

Verified across runtimes during the build: every workbook this package writes for the golden
fixtures opens in openpyxl, matches the Python-written reference cell for cell, and passes
the reference toolkit's own `--validate` QA gates.
