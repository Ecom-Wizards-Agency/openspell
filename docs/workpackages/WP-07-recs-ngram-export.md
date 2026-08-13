# WP-07 — Recommendations UI, N-gram explorer, export bridge (`apps/web`)

**Owner:** Codex · **Phase:** v1 · **Depends on:** WP-05 (types + engine), WP-06 (grid), recon optimizer-preview spec (WP-11)

## Goal

The review surface for engine proposals and the v1 apply path: export accepted proposals for
the existing operator-side staged-apply flow. v1 writes NOTHING to Amazon.

## Read first

- `docs/PLAN.md` — "v1 module scope" items 6–7 and the export-bridge rationale.
- `~/os/amazon-agent/tools/amazon-ppc-management/batches.py` — the consumer of your rows JSON
  (`validate` subcommand is your compatibility oracle).
- `~/os/amazon-agent/tools/amazon-campaign-builder/references/bulksheets-2.0-reference.md` —
  Bulk Operations XLSX format rules (partial-update semantics, entity columns).
- Recon spec for AdLabs' optimizer preview UI (what operators expect to see).

## Spec

1. **Recommendations review UI:** list per run, grouped by reason; each row shows entity,
   current → proposed, and the full `inputs` provenance (RPC, clicks, CVR source level,
   ceiling applied, cap clamped) — "show your work" is the product differentiator. Actions:
   accept / dismiss (with note) / bulk by filter. Status transitions per shared enum.
2. **N-gram explorer:** uni/bi/tri toggle, scope selector (profile/campaign set/tag), spend/
   sales/CVR per gram, sortable, one-click "propose as negative" (creates a proposal row —
   still no writes).
3. **Export bridge** for accepted proposals:
   - (a) Bulk Operations XLSX per profile (bulksheets 2.0 format, update rows only).
   - (b) rows JSON **byte-compatible with `batches.py`** (`ApplyRow` from shared) + the
     matching caps config, so `/ppc-manage` staged-apply is the executor.
   - Mark exported proposals `exported` with timestamp + export ref; counts shown
     (exported N of M accepted).

## Acceptance checks

- Exported rows JSON passes `python batches.py validate` (operator-run against the real tool;
  provide the fixture + command in your report).
- Exported XLSX opens in the campaign-builder update flow unmodified (operator spot-check).
- Provenance panel renders every `inputs` field for each of the four reasons (fixture-driven
  Storybook or Playwright screenshots).
- Accept→export→status transitions tested; dismissed rows never export.
- Branch `wp-07-recs-export`; report per acceptance check.
