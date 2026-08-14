# WP-19 — Experiments (A/B test tracking)

**Owner:** Claude Opus · **Phase:** v1.x (queue after WP-07 merges — shares apps/web) ·
**Requested by operator 2026-08-14**

## Goal

Track deliberate tests — "push spend on these keywords", "new main image on this ASIN",
"price change" — as first-class experiment records, so their windows are visible on every
chart and their outcomes measurable in the data later, instead of living in someone's memory.

## Spec

1. **Schema (additive migration + queries file):** `experiments` (id, org_id, profile_id,
   name, hypothesis text, type `bid_push|creative|listing_content|price|placement|other`,
   scope jsonb — entity refs: campaign/ad-group/keyword ids, ASINs, search terms —, metric
   focus (e.g. acos|cvr|ctr|sales|share), start_at, end_at nullable while running, status
   `planned|running|ended|analyzed|aborted`, result_note, created_by). RLS like feedback
   (org read; analyst+ create/edit own; admin all).
2. **UI (`/experiments` + overlays):**
   - CRUD list + detail with status transitions; starting an experiment from a grid
     selection pre-fills the scope (keywords/campaigns selected → scope).
   - **Chart overlay**: dashboard + entity trend charts shade experiment windows for the
     profile in view (consume from a small provider; coordinate with the dashboard owner's
     chart components ADDITIVELY — a decoration layer, not a rewrite).
   - **Comparison view** on the experiment detail: before / during / (after when ended)
     windows of equal length for the scoped entities from existing facts (sum/sum derived
     metrics only), next to the profile-level rest-of-account as a rough control, with an
     honest "this is not a randomized test" note.
3. **Links into the rest of the tool:** experiments referencing entity scopes deep-link via
   goto links; `entity_changes` rows inside the window are listed on the detail page ("what
   actually changed during this test"); when WP-12 writes land, apply_batches gain an
   optional experiment_id so pushes ARE the experiment start (seam: nullable column now,
   documented).
4. **MCP:** `list_experiments` + `get_experiment` read tools (audit-logged); creation stays
   in the UI for v1.x.
5. Later lanes (note in brief, don't build): SQP/SUPA share impact for listing tests
   (post-SP-API), DataDive rank overlay, auto-suggested experiments from detected
   entity_changes.

## Acceptance checks

- Create from grid selection → scope captured; windows shade on dashboard + entity charts.
- Comparison view derives before/during metrics from facts (sum/sum, verified vs SQL) and
  handles a still-running experiment (no after window).
- entity_changes inside the window appear on the detail page.
- RLS negatives both layers; Playwright flow (create → running → ended → comparison) green.
- `pnpm check` green; all existing e2e suites green; branch `wp-19-experiments`.
