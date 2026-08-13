# fixtures

Owned by **WP-05**. The Python-to-TypeScript parity harness.

- `generate/` Python scripts that import the reference tools in `amazon-agent/tools/`,
  run every selftest scenario on synthetic data, and dump `{input, expected}` goldens.
  The reference code is a **spec, not a dependency**: read it, port it, never import
  it at runtime and never copy files wholesale.
- `golden/` the dumped goldens. Vitest replays them and asserts deep equality.

Synthetic data only. A golden built from a real account is a client data leak with
extra steps, so `fixtures/golden/**/*.local.*` is gitignored for the cases where a
local-only comparison is genuinely useful.

## Regenerating (operator step)

The Python environment lives in the sibling `amazon-agent` project, so regeneration
is run by hand and the goldens are committed. CI never needs Python.

```bash
WIZARD_ADS_REFERENCE_TOOLS=<path to amazon-agent/tools/amazon-ads-monitor> \
  python3 fixtures/generate/generate_goldens.py
```

The path arrives as an environment variable because no absolute home-directory path
may be written into this repository. A run prints one line per golden with its case
count; a diff in `golden/` after a regeneration means the reference behaviour moved
and the ports must be re-read against it, never that the goldens should be accepted
because the suite is red.

## What is covered

| Golden | Cases | What it pins |
|---|---|---|
| `classify.json` | 12 | Category from campaign name, including the Shield-beats-Rank order |
| `trend.json` | 10 | First-half vs second-half trend classification, holes included |
| `analyze.json` | 5 | Delta arithmetic over five fixtures, incl. the reference mock source |
| `weekly.json` | 3 | Week-over-week sums, recomputed ratios, and the averaged exception |
| `flags.json` | 54 | Every rule x 3 fixtures x 2 configs x 9 goals, active and suppressed |
| `pacing.json` | 11 | Run-rate governor, lens layering, coverage honesty, flag severities |
| `crosscheck.json` | 9 | verified / mismatch / no_data, tolerances, zero-base handling |
| `recommendations.json` | 16 | Push / Pause-Optimize / Test / Graduate, rank protection, notes |

Rendered message strings are compared exactly, which is why the port carries its own
Python-compatible number formatter: `format()` rounds ties to even and `toFixed`
rounds them away from zero, so `12.5` would otherwise render as "13" here and "12"
there in every message that quotes a percentage.

## Interpretations

Places where the reference's behaviour was reproduced deliberately rather than
tidied up. Each is a decision a reviewer may want to overturn; none is a bug fix,
because a fix here would break parity silently.

| # | Reference behaviour | What the port does |
|---|---|---|
| 1 | `Entity.has_headroom` reads the module-level default threshold, not the config-merged one, so `rec_thresholds.budget_headroom_max_utilization` cannot actually change it | Reproduced exactly, with a comment saying so |
| 2 | `_thresholds` silently drops unknown config keys | Reproduced: unknown keys are ignored, not an error |
| 3 | Goal lens `liquidate` maps the non-rank ACOS ceiling to `None`, disabling the check rather than widening it | Reproduced as `null`, with the check skipped |
| 4 | `_check_zero_sales_spend` reads the trailing-7 average, so a single high-spend day never fires it alone | Reproduced |
| 5 | Self-competition groups key on `(name, match_type)` and count distinct campaign ids **including** a null id | Reproduced; the tuple key is flattened with a NUL separator no name carries |
| 6 | Pacing under-pace is withheld on partial coverage, but warn/act are not | Reproduced |
| 7 | Crosscheck treats a zero Sellerboard base with a nonzero counterpart as a full (100%) mismatch | Reproduced |
| 8 | `parse_signal_digest_markdown` returns tag **sets**, whose order is undefined | Ports to arrays; the golden sorts each set so the comparison is stable |
