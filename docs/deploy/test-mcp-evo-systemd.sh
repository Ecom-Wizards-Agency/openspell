#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mcp_unit="$script_dir/openspell-mcp.service"
tunnel_unit="$script_dir/openspell-mcp-tunnel.service"
installer="$script_dir/install-mcp-evo-systemd.sh"
rollback="$script_dir/rollback-mcp-evo-systemd.sh"
launcher="$script_dir/openspell-mcp-launch.mjs"
health="$script_dir/openspell-mcp-health.mjs"
verifier="$script_dir/verify-mcp-evo-systemd.sh"
normalizer="$script_dir/normalize-mcp-evo-artifact.mjs"

for script in "$installer" "$rollback" "$verifier" "$0"; do
  bash -n "$script"
done
node --check "$health"
node --check "$launcher"
node --check "$normalizer"

require_line() {
  local file="$1"
  local line="$2"
  if ! grep -Fqx "$line" "$file"; then
    echo "missing invariant in $(basename "$file"): $line" >&2
    exit 1
  fi
}

require_line "$mcp_unit" "DynamicUser=yes"
require_line "$mcp_unit" "Type=exec"
require_line "$mcp_unit" "LoadCredentialEncrypted=openspell-mcp-database-url:/etc/credstore.encrypted/openspell-mcp-database-url"
require_line "$mcp_unit" "ExecStart=/usr/local/bin/node /opt/openspell-mcp/current/node_modules/tsx/dist/cli.mjs /opt/openspell-mcp/current/bin/openspell-mcp-launch.mjs"
require_line "$mcp_unit" "ExecStartPost=/usr/local/bin/node /opt/openspell-mcp/current/bin/openspell-mcp-health.mjs http://127.0.0.1:8787/healthz \${WIZARD_ADS_MCP_REVISION} 90"
host_key=WIZARD_ADS_MCP_HOST
require_line "$mcp_unit" "Environment=${host_key}=127.0.0.1"
require_line "$mcp_unit" "ProtectSystem=strict"
require_line "$mcp_unit" "ProtectProc=invisible"
require_line "$mcp_unit" "CapabilityBoundingSet="
require_line "$tunnel_unit" "DynamicUser=yes"
require_line "$tunnel_unit" "Type=exec"
require_line "$tunnel_unit" "LoadCredentialEncrypted=openspell-cloudflare-tunnel-token:/etc/credstore.encrypted/openspell-cloudflare-tunnel-token"
require_line "$tunnel_unit" "ExecStart=/opt/openspell-mcp/current/bin/cloudflared tunnel --no-autoupdate run --token-file %d/openspell-cloudflare-tunnel-token"
require_line "$tunnel_unit" "Wants=openspell-mcp.service"
require_line "$tunnel_unit" "ProtectSystem=strict"
require_line "$tunnel_unit" "CapabilityBoundingSet="
if ! rg -F 'sudo test -L "$credential_path"' "$installer" >/dev/null \
  || ! rg -F 'system Node 22 or newer' "$installer" >/dev/null; then
  echo "pinned runtime or credential-file invariant is missing" >&2
  exit 1
fi
if ! rg -F 'install_release_units "$release_dir"' "$installer" >/dev/null \
  || ! rg -F 'install_release_units "$to_target"' "$rollback" >/dev/null \
  || ! rg -F 'sha256sum -c SYSTEMD_SHA256' "$rollback" >/dev/null; then
  echo "versioned systemd unit installation or rollback invariant is missing" >&2
  exit 1
fi
if rg -n -U -- 'install_release_units[^\n]*(\\\n[^\n]*)?\|\| true' \
  "$installer" "$rollback" \
  || ! rg -F 'services remain stopped for manual recovery' \
    "$installer" "$rollback" >/dev/null; then
  echo "unit restoration is not fail-closed" >&2
  exit 1
fi
if rg -n -U -- '"\$script_dir/openspell-mcp[^\n]+\n[^\n]*/etc/systemd/system' \
  "$installer"; then
  echo "staging can install unversioned unit definitions" >&2
  exit 1
fi

for forbidden_pattern in \
  '/home/' \
  'op://' \
  'Environment=.*(DATABASE|TOKEN)' \
  '--token[=[:space:]]+[^$%]'; do
  if rg -n -- "$forbidden_pattern" \
    "$mcp_unit" "$tunnel_unit" "$installer" "$launcher" "$health" "$normalizer" "$rollback" "$verifier"; then
    echo "deployment files contain a forbidden home, item, or inline-secret route" >&2
    exit 1
  fi
done
if [[ -e "$script_dir/mcp-evo.compose.yaml" \
  || -e "$script_dir/check-mcp-evo-compose.sh" ]]; then
  echo "legacy Compose deployment files still exist" >&2
  exit 1
fi

test_tmp="$(mktemp -d /tmp/openspell-mcp-health-test.XXXXXX)"
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  case "$test_tmp" in
    /tmp/openspell-mcp-health-test.*)
      find "$test_tmp" -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
package_fixture="$test_tmp/package"
if ! pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/mcp deploy "$package_fixture" \
  >"$test_tmp/package.log" 2>&1; then
  echo "MCP runtime packaging fixture failed" >&2
  exit 1
fi
node "$normalizer" "$package_fixture" >/dev/null
if [[ ! -f "$package_fixture/node_modules/tsx/dist/cli.mjs" \
  || ! -f "$package_fixture/src/bin/serve.ts" ]]; then
  echo "MCP runtime packaging fixture is incomplete" >&2
  exit 1
fi
if rg --hidden --no-ignore -I -q -F "$repo_root" "$package_fixture" \
  || rg --hidden --no-ignore -I -q 'file:///(home|Users)/' "$package_fixture" \
  || find "$package_fixture" -path '*home+*' -print -quit | grep -q .; then
  echo "MCP runtime packaging fixture retains checkout path metadata" >&2
  exit 1
fi
if find "$package_fixture" \( -type f -o -type d \) -perm /022 -print -quit \
  | grep -q .; then
  echo "MCP runtime packaging fixture contains unsafe writable content" >&2
  exit 1
fi
(cd "$package_fixture" && node node_modules/tsx/dist/cli.mjs -e \
  '(async () => { await import("@wizard-ads/core"); await import("@wizard-ads/db"); })()')

second_package_fixture="$test_tmp/package-second"
if ! pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/mcp deploy "$second_package_fixture" \
  >"$test_tmp/package-second.log" 2>&1; then
  echo "second MCP runtime packaging fixture failed" >&2
  exit 1
fi
node "$normalizer" "$second_package_fixture" >/dev/null
if ! diff -qr "$package_fixture" "$second_package_fixture" >/dev/null; then
  echo "normalized MCP runtime packaging is not path-independent" >&2
  exit 1
fi

install -d -m 0755 "$package_fixture/systemd"
install -m 0644 "$mcp_unit" "$package_fixture/systemd/openspell-mcp.service"
install -m 0644 "$tunnel_unit" \
  "$package_fixture/systemd/openspell-mcp-tunnel.service"
(cd "$package_fixture" && sha256sum \
  systemd/openspell-mcp.service \
  systemd/openspell-mcp-tunnel.service >SYSTEMD_SHA256)
(cd "$package_fixture" && sha256sum -c SYSTEMD_SHA256 >/dev/null)

install -d -m 0700 "$test_tmp/systemd"
sed -e '/^EnvironmentFile=/d' \
  -e 's#^ExecStart=.*#ExecStart=/bin/true#' \
  -e 's#^ExecStartPost=.*#ExecStartPost=/bin/true#' \
  "$mcp_unit" >"$test_tmp/systemd/openspell-mcp.service"
sed -e 's#^ExecStart=.*#ExecStart=/bin/true#' \
  "$tunnel_unit" >"$test_tmp/systemd/openspell-mcp-tunnel.service"
systemd-analyze verify \
  "$test_tmp/systemd/openspell-mcp.service" \
  "$test_tmp/systemd/openspell-mcp-tunnel.service"

fixture_revision=0000000000000000000000000000000000000000
node -e '
  const http = require("node:http");
  const revision = process.argv[1];
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: "ready", service: "openspell", product: "OpenSpell", revision,
    }));
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
' "$fixture_revision" >"$test_tmp/port" &
server_pid=$!
for _ in $(seq 1 50); do
  [[ -s "$test_tmp/port" ]] && break
  sleep 0.05
done
port="$(<"$test_tmp/port")"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "health fixture failed to start" >&2
  exit 1
fi
node "$health" "http://127.0.0.1:$port/healthz" "$fixture_revision" 1 >/dev/null
if node "$health" "http://127.0.0.1:$port/healthz" \
  1111111111111111111111111111111111111111 1 >/dev/null 2>&1; then
  echo "health verifier accepted the wrong revision" >&2
  exit 1
fi

echo "OpenSpell MCP systemd deployment invariants passed"
