# crosscheck-cli

Owned by **WP-10**. The trust machine: our synced facts against the incumbent's numbers, per
profile-day and per campaign-week, and the report that decides whether v1 has earned the right to
write anything back to Amazon.

Everything in this product is read-only until this package says the numbers agree. That is why it
is a package and not a script — the worker, the web panel and the exit report all run the same
comparison rather than three that agree on a good day.

## What is in here

| Module | What it is |
|---|---|
| `csv.ts` | A dependency-free CSV reader that sniffs its delimiter and its decimal separator. |
| `contract.ts` | The export contract: file naming, column aliases, the profile filter. See `docs/adlabs-export-contract.md`. |
| `compare.ts` | What gets compared and what a verdict means once written down. The verdict *model* is `crossCheck` in `@wizard-ads/core`. |
| `facts.ts` | Our side, read from `fact_profile_daily` and the SP-target/SB/SD union. |
| `results.ts` | Upsert into `crosscheck_results`, and read the history back. |
| `job.ts` | `runCrosscheckIngest` — the whole `crosscheck.ingest` handler, called by the worker. |
| `inbox.ts` | The directory the exports land in, and the `processed/` archive. |
| `panel.ts` | The view model behind the dashboard chip and the crosscheck page. Pure. |
| `exit-report.ts` | The v1 exit criterion, evaluated and rendered as markdown. |
| `cli.ts` | `scan`, `ingest`, `report`, `exit-report`. |

Two entry points: `@wizard-ads/crosscheck-cli` (everything) and
`@wizard-ads/crosscheck-cli/pure` (no I/O — what the web tier imports).

## Using it

```bash
export DATABASE_URL=…            # a service-role connection string

# what is waiting in the inbox
pnpm --filter @wizard-ads/crosscheck-cli crosscheck scan --inbox ./inbox

# compare one profile now (the same code path the worker runs)
pnpm --filter @wizard-ads/crosscheck-cli crosscheck ingest \
  --profile <profile-uuid> --path ./inbox --date 2026-08-14

# the verdict history, as a table
pnpm --filter @wizard-ads/crosscheck-cli crosscheck report --profile <profile-uuid>

# the gate
pnpm --filter @wizard-ads/crosscheck-cli crosscheck exit-report \
  --from 2026-08-01 --out exit-report.md \
  --optimizer-parity-note "…what the spot-check found…"
```

## The three rules the comparison lives by

1. **A missing figure is `no_data`, never zero.** Recorded with a direction — `missing_ours` when
   our sync has nothing, `missing_theirs` when the incumbent has nothing — because "the sync
   missed a campaign" and "they have not caught up" are different problems.
2. **The provisional day is excluded and shown.** Sales restate for 14+ days and the incumbent's
   totals read 0 for the in-progress day. It is recorded as `skipped_provisional` with both
   figures kept, so "excluded" is a claim a reader can check.
3. **A campaign neither side reported spend or sales for is not a data point.** It is dropped and
   counted, so the campaign-grain share is taken over campaigns that could have disagreed.

## Fixtures

`fixtures/` holds synthetic AdLabs exports; `src/fixtures.ts` holds our side of the same synthetic
account. They are arithmetically consistent by construction — the campaign dailies sum to the
profile dailies, and the clean export is our figures within tolerance — which is what makes the
corrupted export's single 12% campaign the only thing that can fail.

| Fixture | What it proves |
|---|---|
| `inbox/adlabs_profile_…_2026-08-01_2026-08-07.csv` | The clean week verifies. Also carries three rows for another profile: the incumbent's export is wide whatever you ask it for. |
| `inbox/adlabs_campaign_…csv` | Four campaigns, all within tolerance. |
| `corrupted/adlabs_campaign_…csv` | One campaign 12% out. Exactly one campaign may be flagged. |
| `provisional/adlabs_profile_…_2026-08-08.csv` | The in-progress day, badly under-reported. The week still verifies. |
| `inbox/adlabs_profile_9900000002_….csv` | Semicolons, comma decimals, a byte-order mark. |

Nothing here came from a real account and nothing here ever may.

## Tests

```bash
pnpm --filter @wizard-ads/crosscheck-cli test          # pure suites
WIZARD_ADS_TEST_DATABASE_URL=postgres://…/postgres \
  pnpm --filter @wizard-ads/crosscheck-cli test        # plus the database suite
```

`job.test.ts` applies the real migrations to a throwaway database and runs the handler end to end.
It skips itself when no Postgres is reachable, so a machine without one still gets an honest
`pnpm check` — and a `pnpm test` at the repo root does not pass the variable through, so run the
database suite from the package.
