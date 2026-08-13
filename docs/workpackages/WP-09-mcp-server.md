# WP-09 — MCP server, read-only (`apps/mcp`)

**Owner:** Claude Opus · **Phase:** v1 · **Depends on:** WP-01 (queries), WP-05 (core outputs); ships inside v1

## Goal

wizard-ads' own MCP server so Claude (and other MCP clients) can query the data — modeled on
the AdLabs MCP surface, read-only in v1, every call audit-logged. This also dogfoods the data
layer during the crosscheck period.

## Read first

- `~/os/amazon-agent/skills/amazon-audit/references/source-adlabs.md` — the AdLabs MCP surface
  (entities, fields, mechanics gotchas). It is the model AND the bar.
- `~/os/amazon-agent/docs/ads-runtime-notes.md` — AdLabs MCP operational caveats; design ours
  to avoid those exact traps (e.g. profile filtering must actually filter).
- MCP TypeScript SDK docs (`@modelcontextprotocol/sdk`), Streamable HTTP transport.

## Spec

1. **Transport/auth:** Streamable HTTP on its own port (same Fly app as worker); per-org API
   keys (hashed in DB, revocable, scoped read-only in v1). Every call → `audit_log`
   (actor_type `mcp`, key id, tool, params, result summary).
2. **Tools (read-only v1):**
   - `get_entity_data` — entity-level metrics for campaign/ad_group/keyword/target/
     search_term/product with date ranges, deltas vs prior period, filters; profile_id
     REQUIRED and actually honored.
   - `query` — safe SELECT-shaped analytics over facts (whitelisted columns/aggregations,
     org-scoped; no raw SQL passthrough).
   - `group_by` — grouped aggregates with recalculated derived metrics (sum/sum).
   - `download_data` — CSV export of a query result (size-capped).
   - `get_recommendations` — latest run's proposals incl. `inputs` provenance.
   - `get_flags`, `get_pacing` — core outputs per profile.
   - `create_goto_link` — returns a deep link into the UI at the exact filtered view.
   - `list_profiles`, `get_sync_status` (freshness from `report_requests`).
3. **Resources:** `wizardads://instructions` (bootstrap usage doc), per-profile context
   resource (account context + strategy summary + recent changes — the Context-Manager
   equivalent; content assembled from DB, no confidential values beyond the org's own data).
4. Write tools: typed stubs returning "gated until v1.x" errors (so clients discover the
   future surface without any write path existing).

## Acceptance checks

- A Claude Code session against staging answers "top 10 wasted-spend targets last week for
  profile X" correctly vs a hand-run SQL check.
- Every call visible in `audit_log` with params; revoked key → 401 (tests).
- Org A key cannot read org B data (negative test at the tool layer, not just RLS).
- `get_entity_data` with profile_id returns ONLY that profile's rows (the AdLabs bug we don't
  repeat — explicit test).
- Branch `wp-09-mcp`; report per acceptance check.
