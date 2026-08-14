# WP-10 → WP-06: the crosscheck verdict chip and panel

**From:** WP-10 (crosscheck harness) · **To:** WP-06 (grid + dashboard) · **Status:** ready to import; one
repo-wide build blocker below, not caused by this code

## Blocker: `next build` cannot resolve any workspace package (pre-existing)

Turbopack does not resolve the `.js` specifiers our TypeScript sources use, so **any** route that
imports **any** workspace package fails the production build today. Reproduced on a throwaway page
whose only import was `@wizard-ads/shared`:

```
./packages/shared/src/index.ts:14:1
Error: Module not found: Can't resolve './apply.js'
  Import trace: ./packages/shared/src/index.ts → ./apps/web/app/<page>.tsx
```

`transpilePackages` does not fix it (already listed for `shared` and `ui`). Dropping the `.js`
suffix does: with `packages/shared/src/index.ts` rewritten to extensionless imports, that file
resolved and the error moved one level deeper, into the next package file still carrying `.js`.

Nothing is broken in the meantime — `pnpm check` (typecheck, lint, test, hygiene) is green, and
`next dev`/`next build` is not part of it — but the fix belongs to whoever owns the web app and the
scaffold, not to WP-10, so no config or shared file was touched here. Two candidate fixes:

1. Repo-wide: relative imports without the `.js` extension (`moduleResolution: "Bundler"` already
   allows it, and every consumer we have — tsx, vitest/esbuild, Turbopack — resolves it).
2. Bundler-side: an extension alias (`resolve.extensionAlias` under webpack; the Turbopack
   equivalent needs checking against Next 16).

Whichever is chosen, decide it once and apply it everywhere: this blocks WP-04, WP-06, WP-07 and
WP-08 equally, and the first route any of us ships hits it.

WP-06's dashboard spec asks for a "crosscheck verdict chip (WP-10 data)". Here is the data, the
chip, and a working page to lift it from. No dashboard file was touched by this work package.

## What exists today

- `apps/web/app/crosscheck/page.tsx` — a standalone route: profile switcher, verdict history,
  drill-down into disagreeing campaign-weeks. Server component, reads the database directly.
- `apps/web/app/crosscheck/panel.tsx` — `<CrosscheckChip>` and `<CrosscheckPanel>`, presentational
  and pure. Inline styles only, so nothing collides with the design system you land.
- `@wizard-ads/crosscheck-cli/pure` — the view model and the verdict vocabulary. **No I/O**: no
  database driver, no `node:fs`. This is the import the dashboard should use.

When the real dashboard lands, either import these two components or reimplement them against the
same view model. Both are fine; what should not happen is a second decision about what a verdict
means.

## The chip, on the dashboard

```tsx
import { loadCrosscheckPanel, withDatabase } from '@wizard-ads/crosscheck-cli';
import { CrosscheckChip } from '../crosscheck/panel';

const model = await withDatabase((handle) => loadCrosscheckPanel(handle, { profileId }));
// model === null when no database is configured
{model ? <CrosscheckChip chip={model.chip} /> : null}
```

If you prefer to fetch once and pass down, `buildPanelModel(rows, { campaignNames })` from
`/pure` turns stored rows into the same model, so a dashboard that already reads
`crosscheck_results` in one query does not need a second round trip.

## The view model

```ts
interface VerdictChip {
  verdict: 'verified' | 'mismatch' | 'missing_ours' | 'missing_theirs'
         | 'skipped_provisional' | 'no_data';
  label: string;          // "Verified", "Missing on our side", "Not cross-checked"
  tone: 'good' | 'warn' | 'bad' | 'muted';
  asOf: string | null;    // most recent *compared* day
  verifiedStreak: number; // consecutive verified days ending at asOf — the v1 gate, live
}

interface CrosscheckPanelModel {
  profileId: string | null;
  chip: VerdictChip;
  days: PanelDay[];                     // newest first, including skipped days
  mismatchingCampaigns: PanelCampaign[];// only the ones that disagree, worst delta first
  campaignsCompared: number;
  tolerance: number;
  sources: string[];                    // the exports the verdicts came from
}
```

`verdictLabel()` and `verdictTone()` are exported too, so a grid cell or a tooltip elsewhere in
the product renders a verdict the same way the chip does.

## Four things the chip must not do

1. **Never show `verified` when nothing was compared.** `no_data` is a distinct state with its own
   label ("Not cross-checked"). A green chip over an empty comparison is the exact failure this
   whole subsystem exists to prevent.
2. **Never take the chip from the newest row.** The newest row is usually the in-progress day,
   which is `skipped_provisional`. `chip.asOf` is the newest *compared* day; the view model
   already does this.
3. **Show the skipped day in the history, greyed.** `days` includes it deliberately. A hole in a
   verdict history reads as a failure nobody can investigate.
4. **Do not confuse this with freshness.** Your freshness banner comes from `report_requests`;
   this chip says whether the numbers we hold agree with the incumbent's. A profile can be fresh
   and wrong, or stale and verified, and an operator needs to see which.

## Data note

`crosscheck_results` carries RLS with a read policy for `authenticated`, so a signed-in member of
the org can read their own verdicts through the normal client. No service-role key is needed to
render the panel. The rows are written by the worker, never by the web tier.

## Where the numbers come from, in one line each

- Profile-day rows: our `fact_profile_daily` against the incumbent's daily export, ±7%.
- Campaign-week rows: our SP-target/SB/SD union summed per campaign against their campaign export.
- `metric` is `ad_spend`, `ad_sales`, or `headline` (the roll-up; it carries no figures).
- `grain` is `profile` or `campaign_week`.
