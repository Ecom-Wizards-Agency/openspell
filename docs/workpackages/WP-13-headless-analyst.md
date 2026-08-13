# WP-13 — Headless AI analyst (v1.x) — GATED

**Owner:** Claude Opus · **Phase:** v1.x · **GATE: needs WP-09 (MCP) live and stable. The
manager opens this gate explicitly.**

## Goal (summary now; full brief written at gate-open)

A scheduled daily analyst: a headless Claude run (Claude Agent SDK) that reads wizard-ads data
via the MCP server (read-only key), analyzes each enabled profile against its strategy, writes
structured findings to the `insights` table, and posts a digest to Slack via the guarded
Wizards AI helper (`~/os/wizards-ai/slack.sh` conventions — never a direct Slack write).

## Design points (already fixed)

- Reads ONLY via MCP with a read-only key; `audit_log` must prove zero write calls.
- Per-profile context resource (WP-09's Context-Manager equivalent) is the briefing input.
- Optional operator-machine variant may additionally read amazon-agent workspace context
  (routing per `~/os/AGENTS.md`); the hosted variant reads only wizard-ads data.
- Insights are structured (`insights` table: findings jsonb + markdown) so the UI and future
  runs can consume them; digest follows amazon-ads-monitor's report conventions
  (`~/os/amazon-agent/tools/amazon-ads-monitor/report.py` as tone/format reference).

## Acceptance checks (preview)

- Daily run produces an insight referencing real data with correct figures (spot-audited).
- audit_log shows zero write-tool calls by the analyst key.
- Digest lands in Slack via the guarded helper, house-style compliant.
