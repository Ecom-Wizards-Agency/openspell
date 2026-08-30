# WP-24 — AdLabs-fidelity UI round 2 (from the operator Cap video)

**Owner:** Opus · **Phase:** v1 polish · **Depends on:** WP-23 (merged) · ecom-wizards-brand visual-quality review + dataviz skills

Source: Cap video `93nt5nwjwcfzx8n`. He likes v1 + dark mode; wants closer AdLabs parity. Every
item below is a real ask from that recording. Presentation-only where possible; new read-only
pages allowed. Keep every existing data-testid + e2e hook; all web e2e must stay green.

## High priority

- **Dense AdLabs-style data tables**: rebuild the grid chrome to match AdLabs' Bid-Optimizer
  table density — columns like Opt Group / Campaign / Bid Strategy / Spend / Start Date, the
  Change-Reasons vs Limit-Reasons split (recon `02-data-grid.md`, `04-optimizer.md`). Consume the
  existing `packages/ui` DataGrid; do not rewrite it.
- **Campaign Optimizer view** at campaign level, laid out like AdLabs (recon `04-optimizer.md`):
  preview table + reason/limit pills + the KPI tile row + a D/W/M chart. Reads the recommendations
  the engine already produces (WP-07); this is the AdLabs-style *presentation* of them.
- **Optimization Groups** surfaced as a concept (grouping in the optimizer/grid). If there's no
  backing model yet, present tags/opt-group naming as the grouping and note the gap.

## Medium

- **Profile switcher** = top-right dropdown with a search box + profile list + "Manage Profiles"
  link (AdLabs pattern), replacing/augmenting the current inline selector; consistent across pages.
- **Move Feedback + Roadmap out of Settings tabs** — they already live in the sidebar PRODUCT
  group, so *remove the duplicate Settings tabs* (de-dupe), keep the sidebar entries.
- **Connect AMC** and **Connect Seller/Vendor Central** buttons on Settings→Connections, as
  disabled "coming soon" stubs (backends are gated WPs 16 / SP-API).
- **AI (MCP) nav item** in the sidebar → a **Connect Claude** page (issue/list/revoke an MCP key —
  ties to WP-09's key CLI + WP-17). The MCP server exists; this is the missing UI entry.
- **Match chart types to AdLabs**: D/W/M toggles + the KPI tile row (Spend/Sales/Orders/ROAS/
  ACOS/RPC/Impr/Clicks/CTR/CPC/AOV/CPA/CVR/CPM) — use the dataviz skill.

## Low

- Sidebar icons per nav item; sidebar collapse/expand toggle; rename ambiguous labels.

## New features from the video → separate briefs, NOT this WP (note only)

- **Time Machine** (AdLabs change history) — a read-only UI over `entity_changes` + apply history.
  Route to its own Opus brief (v2 batch), not WP-24.
- **Dayparting** — needs Marketing Stream; latest lane.

## Verify-before-build (ambiguities from the video)

Confirm against the LIVE app first: "more options on top" (top bar vs left-rail top); the AI/MCP
item (confirmed absent — build it); the "give it a better name" target; the "here it's not
showing" dark-mode/AI-panel remark. Use the Chrome tools against ads.ecomwizards.agency if helpful.

## Acceptance

- `pnpm check` + all web e2e green (update tests only for deliberate markup changes, never drop
  coverage). Live visual review against the 13 recon screenshots + the video.
- Branch `wp-24-adlabs-ui`. Report per item: done / deferred-with-reason.
