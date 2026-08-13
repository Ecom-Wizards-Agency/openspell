# WP-11 — AdLabs recon (UI walkthrough + MCP surface) → specs

**Owner:** Claude Opus + operator (Victor logs in) · **Phase:** v0, day 1 — fully parallel · **Feeds:** WP-06/07/08 and v1.x write specs

## Goal

Document AdLabs' actual product — every screen, workflow, and data surface — into specs in
`tools/recon/`, so our UI work clones reality instead of marketing copy. Output is SPECS ONLY,
no code.

## Session setup

Victor logs into app.adlabs.app in Chrome; the agent drives via the Chrome browser tools
(read_page/screenshots/navigation). Read-only recon: do NOT create/modify/apply anything in
AdLabs — no optimizer submissions, no harvest runs, no settings changes. Navigating and
opening previews is fine; anything with a confirm/apply button stops at the preview.

## Read first

- `~/os/amazon-agent/skills/amazon-audit/references/source-adlabs.md` (MCP surface — merge,
  don't duplicate)
- `~/os/amazon-agent/docs/ads-runtime-notes.md` (known behaviors to verify in UI)
- `~/os/agency/Research/_sources/video-transcripts/that-amazon-ads-podcast/adlabs-tutorial-quick-easy.md`
  and `adlabs-tutorial-advanced.md` (their own walkthroughs — pre-read to build the nav map)

## Coverage checklist (one spec file per area in `tools/recon/`)

1. Navigation map (every top-level section + subpage).
2. Data grid: entity levels, exact column sets per level, filter UI semantics, group-by
   behavior, saved views, export.
3. Dashboard(s): widgets, periods/comparisons, drill-downs, share/white-label flow.
4. Optimizer: preview table layout, reason labels, how inputs/ceilings are displayed, approval
   flow UX, settings (prioritization levels, ceilings, caps).
5. Harvesting / campaign maps: map builder UI, per-map settings (starting bid, match type,
   source negation), bulk template, run/history views.
6. Tags: nesting UX, assignment flows, where tags filter.
7. SQP reports section (what they show without SP-API of their own?  document data source
   claims), n-gram/search-term tools, negatives workflows.
8. Alerts/automations (Pro), dayparting surface if visible, budget tools.
9. Settings: profile management, target ACOS config levels, user/team management, MCP key
   management + Context Manager UI.
10. Goto-link behavior (how deep links restore state).

Per area: screenshots (numbered, saved under `tools/recon/screenshots/`), the workflow as
steps, exact field/column names, and a short "what we clone / what we skip / what we beat"
verdict. Cross-reference the MCP surface doc where the UI exposes the same primitive.

## Acceptance checks

- One spec file per checklist area, each with screenshot refs and the clone/skip/beat verdict.
- Nav-map coverage: every section in the nav map is either specced or explicitly skipped with
  reason.
- No state changes in AdLabs (session log confirms read-only).
- Manager reviews coverage against the nav map.
