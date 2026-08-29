# WP-113 — OpenSpell MCP connection name

## Outcome

New Codex and Claude setup snippets register the public MCP service as `openspell`.
Stable repository, package, header, and environment-variable identifiers remain unchanged.

## Acceptance

- Claude configuration uses the `openspell` server key.
- Codex setup uses `codex mcp add openspell`.
- Snippets still reference `WIZARD_ADS_MCP_TOKEN` rather than embedding a token.
- The production endpoint remains exact and contains no placeholder hostname.
