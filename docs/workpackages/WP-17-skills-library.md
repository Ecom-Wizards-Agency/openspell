# WP-17 — Pre-installed AI skills library

**Owner:** Claude Opus (content-heavy; manager reviews each skill) · **Phase:** v1.x ·
**Depends on:** WP-09 (MCP, merged). Idea from operator 2026-08-14, validated against
adlabs.app/skills (8 skills: audit, SQP report, AMC SQL writer, SP launch bulksheet,
inventory workbook, rising-ACOS + falling-sales diagnostics, dayparting calc — delivered as
downloadable .skill files, the MCP-connected ones doubling as their trial funnel).

## Goal

wizard-ads ships with a curated library of AI skills that work against OUR MCP server:
downloadable skill files + an in-app "Connect Claude" page that hands out an MCP key, the
setup steps, and the skill pack. For the agency it standardizes how the team's Claude
sessions use the tool; for the later public product it is the onboarding funnel AdLabs
proved.

## Source advantage

`~/os/amazon-agent/skills/` holds 27 operational skills, many deeper than AdLabs' catalog
(audit, SUPA, campaign building, inventory planning, troubleshooting). These are SPEC
SOURCES ONLY: every shipped skill is REWRITTEN public-safe against the wizard-ads MCP
surface — no client names, no agency thresholds (those live in tenant strategy and are read
via MCP at runtime), no vault/repo paths, no MAG SOP content. The hygiene lint applies to
skill files like everything else.

## v1 skill set (proposal — manager approves final list)

1. `wizardads-ppc-audit` — read-only account audit → HTML report (MCP-connected; our
   audit-skill lineage, their headline skill matched).
2. `wizardads-rising-acos` / `wizardads-falling-sales` — fixed-order diagnostics
   (MCP-connected; decompose via get_entity_data deltas).
3. `wizardads-weekly-brief` — the ads-monitor-style weekly performance brief.
4. `wizardads-campaign-brief-to-plan` — turns a plain-text launch brief into a
   packages/campaigns plan via the tool (points at the in-product generator rather than
   reimplementing it — explicitly better than a bulksheet-recipe skill).
5. `amc-sql-writer` equivalent — standalone, ships when WP-16 opens.

## Mechanics

- Skill files live in `skills/` in this repo (public-safe, hygiene-linted), versioned with
  the product; the web app serves them from a `/connect-claude` page along with per-org MCP
  key issuance (WP-09's key CLI grows a UI surface here).
- Each skill declares which MCP tools it needs; a skill-lint checks the declared tools exist
  on the server (contract test between skills/ and apps/mcp).
- Standalone skills (no MCP needed) are allowed but secondary.

## Acceptance sketch

Each shipped skill: runs end-to-end in a fresh Claude session against staging with only the
skill file + an issued key · produces its artifact correctly on dev-seed data · passes
hygiene · declared-tools contract test green. The /connect-claude page issues, lists, and
revokes keys with role gating.
