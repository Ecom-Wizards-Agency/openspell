# WP-211 — Brand alignment and hygiene scrub

Owner: Claude (design). The implementer must not edit the owned files.

Depends on: decision D5 in `docs/workpackages/REPLAN-2026-09-05.md`. Recommendation assumed:
`docs/design/DESIGN-SYSTEM.md` governs the product UI, the agency brand skill governs client
documents, the current OpenSpell mark stays.

## Findings

The token layer in `apps/web/src/ui/theme.css` matches Brand Guide V2.3 and is pinned by
`design-system.test.ts`. Gaps: no hairline token, `packages/ui/src/theme.ts` carries a second
unpinned fallback palette, warn reuses the orange accent in all three theme scopes, the tag
manager accepts any color and the tags API stores any string, the favicon is a single SVG with
no PNG or Apple icon or Open Graph image, two type scales coexist (`tokens.ts` inline heading
versus `.wa-page-title`), and `DESIGN-SYSTEM.md` says dark is the primary system while the code
has always defaulted to light. The brand mark is a pinned release artifact
(`apps/web/src/ui/artifact-markers.ts`), so any swap must bump the marker. Three tracked docs
contain an account label or a seller identifier, which the public-repository rule forbids.

## Owned files

- `apps/web/src/ui/theme.css` (token block and warn scopes), `apps/web/src/ui/tokens.ts`,
  `apps/web/src/ui/design-system.test.ts`, `packages/ui/src/theme.ts`,
  `packages/ui/src/GridToolbar.tsx` (one hardcoded color);
- `packages/shared/src/tags.ts` or the tag contract file (add a `TagColor` enum; Claude owns
  the contract change as manager);
- `apps/web/app/tags/**`, `apps/web/app/api/tags/**`;
- `apps/web/app/icon.png`, `apps/web/app/apple-icon.png`, `apps/web/app/opengraph-image.*`,
  `apps/web/app/layout.tsx` metadata block;
- `docs/design/DESIGN-SYSTEM.md`;
- `docs/design/AUDIT-2026-08-27.md`, `docs/design/QA-2026-08-27.md`,
  `docs/workpackages/WP-44B-mrp-live-fit.md` (scrub only);
- `_local/hygiene-denylist.TEMPLATE.txt` (comment lines only);
- this brief.

## Required behavior

1. Hygiene first, separate PR: remove the account labels and the seller identifier from the three
   docs (the QA document also carries client names at line 33), add the terms to the operator's
   gitignored denylist, and record the decision on history rewriting in `docs/DECISIONS.md`.
2. Add the hairline token, point light borders at it, align the `packages/ui` fallbacks, extend
   the design-system test to read `packages/ui/src/theme.ts` so both palettes are pinned.
3. Introduce a dedicated warn hue and remove the accent double-duty in all three scopes; check
   every warn consumer in both themes including the settling band in the chart.
4. `TagColor` enum in the contract, validated in the tags API, swatches instead of the free color
   input; existing rows with arbitrary values render with a neutral fallback.
5. One type scale: remove the inline heading style from `tokens.ts` or make it read the class
   tokens; reconcile weights in the doc with the CSS.
6. Icon set and Open Graph metadata through Next metadata file conventions.
7. `DESIGN-SYSTEM.md`: light default with OS preference and in-app toggle; a section on the
   relationship to the agency brand contract; record that screen good and bad colors differ from
   the figure builder on purpose.
8. Ops note for the operator, outside the repo: brand the Supabase magic-link email as OpenSpell.

## Acceptance

1. `pnpm hygiene` passes with the denylist present and the scrubbed docs staged.
2. `design-system.test.ts` pins both palettes and the contrast checks pass.
3. Tags API refuses a non-enum color; the UI shows swatches only.
4. Favicon renders in Safari and a link preview shows the Open Graph image.
