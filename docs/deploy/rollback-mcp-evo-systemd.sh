#!/usr/bin/env bash
set -euo pipefail

from_revision="${1:-}"
to_revision="${2:-}"
for revision in "$from_revision" "$to_revision"; do
  if [[ ! "$revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
    echo "usage: $0 <current-full-git-object-id> <retained-full-git-object-id>" >&2
    exit 2
  fi
done
if [[ "$from_revision" == "$to_revision" ]]; then
  echo "refusing rollback: current and retained revisions are identical" >&2
  exit 1
fi
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "refusing rollback: system Node 22 or newer is unavailable" >&2
  exit 1
fi

release_root=/opt/openspell-mcp
current_link="$release_root/current"
from_target="releases/$from_revision"
to_target="releases/$to_revision"
if [[ "$(sudo readlink "$current_link" 2>/dev/null || true)" != "$from_target" ]]; then
  echo "refusing rollback: current release no longer matches the expected revision" >&2
  exit 1
fi
for pair in "$from_target:$from_revision" "$to_target:$to_revision"; do
  target="${pair%%:*}"
  expected="${pair#*:}"
  marker="$(sudo cat "$release_root/$target/REVISION" 2>/dev/null || true)"
  if [[ "$marker" != "$expected" ]]; then
    echo "refusing rollback: retained release provenance is invalid" >&2
    exit 1
  fi
  if ! sudo sh -c 'cd "$1" && sha256sum -c SYSTEMD_SHA256 >/dev/null' \
    sh "$release_root/$target"; then
    echo "refusing rollback: retained unit provenance is invalid" >&2
    exit 1
  fi
  approved_connector="$(sudo cat "$release_root/$target/CLOUDFLARED_SHA256" 2>/dev/null || true)"
  actual_connector="$(sudo sha256sum "$release_root/$target/bin/cloudflared" 2>/dev/null | awk '{print $1}')"
  if [[ ! "$approved_connector" =~ ^[0-9a-f]{64}$ \
    || "$actual_connector" != "$approved_connector" ]]; then
    echo "refusing rollback: retained connector provenance is invalid" >&2
    exit 1
  fi
done

switch_link() {
  local target="$1"
  local temporary="$release_root/.current-rollback"
  sudo ln -sfn "$target" "$temporary"
  sudo mv -Tf "$temporary" "$current_link"
}

install_release_units() {
  local target="$1"
  local suffix="$2"
  local release="$release_root/$target"
  local mcp_stage="/etc/systemd/system/.openspell-mcp.service.$suffix"
  local tunnel_stage="/etc/systemd/system/.openspell-mcp-tunnel.service.$suffix"
  sudo install -m 0644 -o root -g root \
    "$release/systemd/openspell-mcp.service" "$mcp_stage" \
    && sudo install -m 0644 -o root -g root \
      "$release/systemd/openspell-mcp-tunnel.service" "$tunnel_stage" \
    && sudo mv -Tf "$mcp_stage" /etc/systemd/system/openspell-mcp.service \
    && sudo mv -Tf "$tunnel_stage" /etc/systemd/system/openspell-mcp-tunnel.service
}

verify_release_units() {
  local target="$1"
  sudo systemd-analyze verify \
    "$release_root/$target/systemd/openspell-mcp.service" \
    "$release_root/$target/systemd/openspell-mcp-tunnel.service"
}

if ! verify_release_units "$from_target"; then
  echo "refusing rollback: current retained unit definitions are invalid" >&2
  exit 1
fi

switch_link "$to_target"
if ! verify_release_units "$to_target"; then
  switch_link "$from_target"
  echo "refusing rollback: destination retained unit definitions are invalid" >&2
  exit 1
fi

restore_original() {
  sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
    >/dev/null 2>&1 || true
  switch_link "$from_target" || return 1
  verify_release_units "$from_target" || return 1
  install_release_units "$from_target" "$from_revision" || return 1
  sudo systemctl daemon-reload || return 1
  sudo systemctl restart openspell-mcp.service || return 1
  sudo systemctl restart openspell-mcp-tunnel.service || return 1
}

if ! install_release_units "$to_target" "$to_revision" \
  || ! sudo systemctl daemon-reload \
  || ! sudo systemctl restart openspell-mcp.service \
  || ! sudo systemctl restart openspell-mcp-tunnel.service \
  || ! /usr/local/bin/node "$release_root/current/bin/openspell-mcp-health.mjs" \
    https://mcp.ecomwizards.agency/healthz "$to_revision" 120; then
  if restore_original; then
    echo "OpenSpell MCP rollback failed; the original deployment was restored" >&2
  else
    sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
      >/dev/null 2>&1 || true
    echo "OpenSpell MCP rollback failed; services remain stopped for manual recovery" >&2
  fi
  exit 1
fi

echo "rolled OpenSpell MCP back from $from_revision to $to_revision"
