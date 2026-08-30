#!/usr/bin/env bash
set -euo pipefail

expected_revision="${1:-}"
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "usage: $0 <full-git-object-id>" >&2
  exit 2
fi
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "OpenSpell MCP system Node 22 or newer is unavailable" >&2
  exit 1
fi

systemctl is-active --quiet openspell-mcp.service
systemctl is-active --quiet openspell-mcp-tunnel.service

health=/opt/openspell-mcp/current/bin/openspell-mcp-health.mjs
if [[ ! -f "$health" || ! -x /usr/local/bin/node ]]; then
  echo "OpenSpell MCP health verifier is unavailable" >&2
  exit 1
fi

/usr/local/bin/node "$health" http://127.0.0.1:8787/healthz "$expected_revision" 1
/usr/local/bin/node "$health" https://mcp.ecomwizards.agency/healthz "$expected_revision" 12

listener="$(ss --listening --tcp --numeric 2>/dev/null \
  | awk '$4 ~ /(^|:)8787$/ {print $4}')"
if [[ "$listener" != "127.0.0.1:8787" ]]; then
  echo "OpenSpell MCP is not bound exclusively to the expected host-local endpoint" >&2
  exit 1
fi

echo "OpenSpell MCP systemd deployment verified at revision $expected_revision"
