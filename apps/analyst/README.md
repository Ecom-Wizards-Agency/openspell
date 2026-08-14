# @wizard-ads/analyst — headless daily analyst (WP-13)

A scheduled, headless run that reads each sync-enabled profile through the
wizard-ads MCP server with a **read-only** key, analyzes it against the profile's
target ACOS, goal lens and doctrine flags, writes a structured row to the
`insights` table, and returns a per-profile Markdown digest.

It is designed to run daily from cron on the always-on Mac mini
(`docs/VISION.md` §4).

## What it does, and what it deliberately does not

- **Reads only through MCP.** Every account number comes through the MCP client
  (`src/mcp-client.ts`), which exposes the read tools and the per-profile context
  resource and *no write tool*. The read-only key enforces the same thing at the
  server. The acceptance proof is that the MCP `audit_log` shows zero write-tool
  calls by the analyst's key (asserted in `analyst.integration.test.ts`).
- **Writes exactly one thing.** The finished insight is inserted straight into
  `public.insights` over a separate, write-capable database connection. Analysis
  reads never travel down it. The org id is resolved inside the insert from the
  profile's own row, so an insight cannot be misfiled.
- **Posts nothing.** Slack is intentionally not wired here. The run prints (and
  persists) each digest; the **operator's downstream step** hands the digest,
  unaltered, to the guarded Wizards AI Slack helper (`~/os/wizards-ai/slack.sh`
  conventions — never a direct Slack write). This process holds no Slack
  credential.

## Configuration (environment)

| Variable | Required | Meaning |
|---|---|---|
| `WIZARD_ADS_ANALYST_MCP_URL` (or `WIZARD_ADS_MCP_URL`) | yes | Streamable HTTP endpoint of the MCP server, ending in `/mcp`. |
| `WIZARD_ADS_ANALYST_MCP_TOKEN` | yes | A read-only `wza_` API key. Never logged, never written to an insight. |
| `WIZARD_ADS_ANALYST_DATABASE_URL` (or `DATABASE_URL`) | yes | Connection string used **only** to write insights. |
| `WIZARD_ADS_ANALYST_LOOKBACK_DAYS` | no (30) | Trailing window for the headline metrics. |
| `WIZARD_ADS_ANALYST_AS_OF` | no | Report on a specific `YYYY-MM-DD` instead of each profile's latest fact day. |
| `WIZARD_ADS_ANALYST_DRY_RUN` | no | `1`/`true` to analyze and print without writing. |

### Issuing the read-only key

The key is minted with the MCP key CLI and pasted into the analyst's
environment; the token is shown once and never stored in this repo:

```
pnpm --filter @wizard-ads/mcp keys issue --org <slug> --label "daily analyst" --days 90
```

Keys are read-only by construction — the server refuses to issue any other kind
in v1 — so there is nothing extra to lock down.

## Running

```
# One real pass (writes insights, prints digests):
pnpm --filter @wizard-ads/analyst start

# Ad-hoc dry run (writes nothing), a specific window:
pnpm --filter @wizard-ads/analyst start -- --dry-run --lookback 14 --as-of 2026-08-13
```

The digest that lands in `insights.body` is the exact string an operator forwards
to Slack downstream.

## Testing

`analyze.test.ts` and `digest.test.ts` cover the pure analysis and rendering and
always run. `analyst.integration.test.ts` migrates a throwaway database, loads
`supabase/seed/dev-seed.ts`, stands up the real MCP server in-process, issues a
genuine read-only key, runs the analyst, and asserts (1) the insight references
the seeded figures and (2) the audit log contains read-tool calls only. It skips
when no Postgres is reachable.

```
# Reuse a local Postgres (e.g. the dev instance on 127.0.0.1:55435):
WIZARD_ADS_TEST_DATABASE_URL="postgres://<user>@127.0.0.1:55435/postgres" \
  pnpm --filter @wizard-ads/analyst test
```

## The AI-narrative layer (future)

The full WP-13 vision is a Claude Agent SDK run that narrates over the data. This
package ships the **deterministic** analyzer as the default and provable path:
figures and findings are a pure function of the briefing, so the acceptance
dry-run is reproducible and offline. A language-model narrator can later be
layered over the same `AnalysisFigures` without changing what is provably true
about the account — it is additive, and was left out here to keep the run
deterministic and to avoid adding a networked LLM dependency to a repo that will
be public. See the report accompanying this work package.
