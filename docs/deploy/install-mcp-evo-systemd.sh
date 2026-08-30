#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 --revision <full-git-object-id> --cloudflared-sha256 <approved-digest> [--activate --route-exclusivity-record <gitignored-json>]" >&2
}

expected_revision=
expected_cloudflared_sha256=
activate=false
route_exclusivity_record=
while (($#)); do
  case "$1" in
    --revision)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      expected_revision="$2"
      shift 2
      ;;
    --cloudflared-sha256)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      expected_cloudflared_sha256="$2"
      shift 2
      ;;
    --activate)
      activate=true
      shift
      ;;
    --route-exclusivity-record)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      route_exclusivity_record="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ "$activate" == true && -z "$route_exclusivity_record" ]]; then
  echo "refusing activation: --route-exclusivity-record is required" >&2
  exit 1
fi
if [[ "$activate" != true && -n "$route_exclusivity_record" ]]; then
  echo "refusing deployment: --route-exclusivity-record is valid only with --activate" >&2
  exit 1
fi

if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing deployment: --revision must be a full lowercase Git object id" >&2
  exit 1
fi
if [[ ! "$expected_cloudflared_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "refusing deployment: --cloudflared-sha256 must be an approved lowercase SHA-256 digest" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
actual_revision="$(git -C "$repo_root" rev-parse HEAD)"
if [[ "$actual_revision" != "$expected_revision" ]]; then
  echo "refusing deployment: checkout does not match the approved revision" >&2
  exit 1
fi
origin_revision="$(git -C "$repo_root" rev-parse --verify refs/remotes/origin/main)"
if [[ "$origin_revision" != "$expected_revision" ]]; then
  echo "refusing deployment: approved revision is not the current origin/main" >&2
  exit 1
fi
if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
  echo "refusing deployment: checkout is not clean" >&2
  exit 1
fi

node_runtime=/usr/local/bin/node
if [[ ! -x "$node_runtime" ]]; then
  echo "refusing deployment: the system Node runtime is unavailable" >&2
  exit 1
fi
node_major="$("$node_runtime" -p 'Number(process.versions.node.split(".")[0])')"
if ((node_major < 22)); then
  echo "refusing deployment: system Node 22 or newer is required" >&2
  exit 1
fi

if [[ "$activate" == true ]]; then
  route_record_path="$(readlink -f -- "$route_exclusivity_record" 2>/dev/null || true)"
  case "$route_record_path" in
    "$repo_root"/_local/*) ;;
    *)
      echo "refusing activation: route exclusivity record must be a gitignored _local file" >&2
      exit 1
      ;;
  esac
  if [[ ! -f "$route_record_path" ]] \
    || ! git -C "$repo_root" check-ignore -q -- "$route_record_path"; then
    echo "refusing activation: route exclusivity record is unavailable or tracked" >&2
    exit 1
  fi
  route_record_mode="$(stat -c '%a' "$route_record_path")"
  if [[ "$route_record_mode" != 600 && "$route_record_mode" != 400 ]]; then
    echo "refusing activation: route exclusivity record permissions are unsafe" >&2
    exit 1
  fi
  if ! "$node_runtime" - "$route_record_path" "$expected_revision" <<'NODE'
const fs = require("node:fs");
const [recordPath, expectedRevision] = process.argv.slice(2);
let record;
try {
  record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
} catch {
  process.exit(1);
}
const expectedKeys = [
  "approvedRevision",
  "expiresAt",
  "hostname",
  "legacyConnectorCredentialsRevoked",
  "origin",
  "routeCount",
  "schemaVersion",
  "unmanagedConnectorCount",
  "verifiedAt",
].sort();
if (!record || typeof record !== "object" || Array.isArray(record)
  || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
  || record.schemaVersion !== 1
  || record.hostname !== "mcp.ecomwizards.agency"
  || record.origin !== "http://127.0.0.1:8787"
  || record.approvedRevision !== expectedRevision
  || record.routeCount !== 1
  || record.unmanagedConnectorCount !== 0
  || record.legacyConnectorCredentialsRevoked !== true) {
  process.exit(1);
}
const verifiedAt = Date.parse(record.verifiedAt);
const expiresAt = Date.parse(record.expiresAt);
const now = Date.now();
if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)
  || verifiedAt > now + 5 * 60_000
  || expiresAt <= now
  || expiresAt > verifiedAt + 60 * 60_000) {
  process.exit(1);
}
NODE
  then
    echo "refusing activation: route exclusivity record is invalid, stale, or incomplete" >&2
    exit 1
  fi
fi

for command in diff git pnpm rg rsync sha256sum sudo systemd-analyze; do
  command -v "$command" >/dev/null || {
    echo "refusing deployment: required command is unavailable: $command" >&2
    exit 1
  }
done

bash "$script_dir/test-mcp-evo-systemd.sh"

credential_store=/etc/credstore.encrypted
credential_ids=(openspell-mcp-database-url openspell-cloudflare-tunnel-token)
for credential_id in "${credential_ids[@]}"; do
  credential_path="$credential_store/$credential_id"
  if ! sudo test -f "$credential_path" || sudo test -L "$credential_path"; then
    echo "refusing deployment: encrypted runtime credential is unavailable: $credential_id" >&2
    exit 1
  fi
  credential_metadata="$(sudo stat -c '%a:%U:%G' "$credential_path")"
  case "$credential_metadata" in
    400:root:root | 600:root:root) ;;
    *)
      echo "refusing deployment: encrypted runtime credential metadata is unsafe: $credential_id" >&2
      exit 1
      ;;
  esac
done

cloudflared_source=/usr/local/bin/cloudflared
if [[ ! -x "$cloudflared_source" ]]; then
  echo "refusing deployment: the reviewed cloudflared binary is unavailable at its fixed runtime path" >&2
  exit 1
fi
actual_cloudflared_sha256="$(sha256sum "$cloudflared_source" | awk '{print $1}')"
if [[ "$actual_cloudflared_sha256" != "$expected_cloudflared_sha256" ]]; then
  echo "refusing deployment: cloudflared does not match its approved digest" >&2
  exit 1
fi
cloudflared_version="$($cloudflared_source --version 2>/dev/null | head -n 1)"
if [[ ! "$cloudflared_version" =~ cloudflared[[:space:]]version[[:space:]]([0-9]{4})\.([0-9]+)\.([0-9]+) ]]; then
  echo "refusing deployment: cloudflared version metadata is invalid" >&2
  exit 1
fi
cloudflared_year="${BASH_REMATCH[1]}"
cloudflared_month="${BASH_REMATCH[2]}"
if ((cloudflared_year < 2025 || (cloudflared_year == 2025 && cloudflared_month < 4))); then
  echo "refusing deployment: cloudflared does not support token-file credentials" >&2
  exit 1
fi

build_root="$(mktemp -d /tmp/openspell-mcp-install.XXXXXX)"
incoming_release=
cleanup() {
  case "$build_root" in
    /tmp/openspell-mcp-install.*)
      find "$build_root" -depth -delete 2>/dev/null || true
      ;;
  esac
  case "$incoming_release" in
    /opt/openspell-mcp/releases/.incoming-*)
      sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

release_stage="$build_root/release"
if ! pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/mcp deploy "$release_stage" \
  >"$build_root/package.log" 2>&1; then
  echo "refusing deployment: MCP release packaging failed" >&2
  exit 1
fi
if ! "$node_runtime" "$script_dir/normalize-mcp-evo-artifact.mjs" "$release_stage" \
  >"$build_root/normalize.log" 2>&1; then
  echo "refusing deployment: MCP release normalization failed" >&2
  exit 1
fi
if rg --hidden --no-ignore -I -q -F "$repo_root" "$release_stage" \
  || rg --hidden --no-ignore -I -q 'file:///(home|Users)/' "$release_stage"; then
  echo "refusing deployment: packaged runtime retains checkout path metadata" >&2
  exit 1
fi
if [[ ! -f "$release_stage/node_modules/tsx/dist/cli.mjs" \
  || ! -f "$release_stage/src/bin/serve.ts" ]]; then
  echo "refusing deployment: packaged MCP runtime is incomplete" >&2
  exit 1
fi
if find "$release_stage" \( -type f -o -type d \) -perm /022 -print -quit \
  | grep -q .; then
  echo "refusing deployment: packaged runtime contains group- or world-writable content" >&2
  exit 1
fi
printf '%s\n' "$expected_revision" >"$release_stage/REVISION"
printf 'WIZARD_ADS_MCP_REVISION=%s\n' "$expected_revision" \
  >"$release_stage/revision.conf"
chmod 0644 "$release_stage/REVISION" "$release_stage/revision.conf"
install -d -m 0755 "$release_stage/bin"
install -m 0644 "$script_dir/openspell-mcp-launch.mjs" \
  "$release_stage/bin/openspell-mcp-launch.mjs"
install -m 0644 "$script_dir/openspell-mcp-health.mjs" \
  "$release_stage/bin/openspell-mcp-health.mjs"
install -m 0755 "$cloudflared_source" "$release_stage/bin/cloudflared"
if [[ "$(sha256sum "$release_stage/bin/cloudflared" | awk '{print $1}')" \
  != "$expected_cloudflared_sha256" ]]; then
  echo "refusing deployment: retained cloudflared binary differs from its approval" >&2
  exit 1
fi
install -d -m 0755 "$release_stage/systemd"
install -m 0644 "$script_dir/openspell-mcp.service" \
  "$release_stage/systemd/openspell-mcp.service"
install -m 0644 "$script_dir/openspell-mcp-tunnel.service" \
  "$release_stage/systemd/openspell-mcp-tunnel.service"
(cd "$release_stage" && sha256sum \
  systemd/openspell-mcp.service \
  systemd/openspell-mcp-tunnel.service >SYSTEMD_SHA256)
chmod 0644 "$release_stage/SYSTEMD_SHA256"
printf '%s\n' "$expected_cloudflared_sha256" >"$release_stage/CLOUDFLARED_SHA256"
chmod 0644 "$release_stage/CLOUDFLARED_SHA256"

while IFS= read -r -d '' link_path; do
  resolved="$(readlink -f "$link_path")"
  case "$resolved" in
    "$release_stage"/*) ;;
    *)
      echo "refusing deployment: packaged runtime contains an external symlink" >&2
      exit 1
      ;;
  esac
done < <(find "$release_stage" -type l -print0)

release_root=/opt/openspell-mcp
release_dir="$release_root/releases/$expected_revision"
incoming_release="$release_root/releases/.incoming-$expected_revision-$$"
if sudo test -e "$release_dir"; then
  installed_revision="$(sudo cat "$release_dir/REVISION" 2>/dev/null || true)"
  if [[ "$installed_revision" != "$expected_revision" ]]; then
    echo "refusing deployment: existing release directory has conflicting provenance" >&2
    exit 1
  fi
else
  if sudo test -e "$incoming_release"; then
    echo "refusing deployment: exact incoming release path already exists" >&2
    exit 1
  fi
  sudo install -d -m 0755 -o root -g root "$release_root/releases" "$incoming_release"
  if ! sudo rsync -a --delete --chown=root:root "$release_stage/" "$incoming_release/"; then
    sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true
    echo "refusing deployment: release copy failed" >&2
    exit 1
  fi
  staged_counts="$(find "$release_stage" -xdev -printf '%y\n' | sort | uniq -c)"
  installed_counts="$(sudo find "$incoming_release" -xdev -printf '%y\n' | sort | uniq -c)"
  if [[ "$staged_counts" != "$installed_counts" ]] \
    || ! sudo diff -qr "$release_stage" "$incoming_release" >/dev/null; then
    sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true
    echo "refusing deployment: incoming release failed artifact reconciliation" >&2
    exit 1
  fi
  if ! sudo mv -T "$incoming_release" "$release_dir"; then
    sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true
    echo "refusing deployment: release publication was not atomic" >&2
    exit 1
  fi
  incoming_release=
fi
if ! sudo diff -qr "$release_stage" "$release_dir" >/dev/null; then
  echo "refusing deployment: installed release differs from its exact staged artifact" >&2
  exit 1
fi

echo "staged OpenSpell MCP release $expected_revision"
if [[ "$activate" != true ]]; then
  echo "services and unit definitions were not changed; rerun with --activate after cutover preparation"
  exit 0
fi

if command -v docker >/dev/null; then
  legacy_containers="$(docker ps --quiet \
    --filter label=com.docker.compose.project=wizard-ads-mcp)"
  if [[ -n "$legacy_containers" ]]; then
    echo "refusing activation: the legacy MCP Compose project is still running" >&2
    exit 1
  fi
fi
if systemctl is-active --quiet wizard-ads-mcp.service 2>/dev/null; then
  echo "refusing activation: the legacy MCP system service is still running" >&2
  exit 1
fi

current_link="$release_root/current"
prior_target="$(sudo readlink "$current_link" 2>/dev/null || true)"
if [[ -n "$prior_target" && ! "$prior_target" =~ ^releases/[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing activation: current release link has invalid provenance" >&2
  exit 1
fi
if [[ -z "$prior_target" ]] && { \
  sudo test -e /etc/systemd/system/openspell-mcp.service \
  || sudo test -e /etc/systemd/system/openspell-mcp-tunnel.service; \
}; then
  echo "refusing activation: unversioned OpenSpell unit definitions already exist" >&2
  exit 1
fi

verify_release_manifest() {
  local release="$1"
  sudo sh -c 'cd "$1" && sha256sum -c SYSTEMD_SHA256 >/dev/null' sh "$release"
}

verify_release_units() {
  local release="$1"
  verify_release_manifest "$release"
  sudo systemd-analyze verify \
    "$release/systemd/openspell-mcp.service" \
    "$release/systemd/openspell-mcp-tunnel.service"
}

install_release_units() {
  local release="$1"
  local suffix="$2"
  local mcp_stage="/etc/systemd/system/.openspell-mcp.service.$suffix"
  local tunnel_stage="/etc/systemd/system/.openspell-mcp-tunnel.service.$suffix"
  sudo install -m 0644 -o root -g root \
    "$release/systemd/openspell-mcp.service" "$mcp_stage" \
    && sudo install -m 0644 -o root -g root \
      "$release/systemd/openspell-mcp-tunnel.service" "$tunnel_stage" \
    && sudo mv -Tf "$mcp_stage" /etc/systemd/system/openspell-mcp.service \
    && sudo mv -Tf "$tunnel_stage" /etc/systemd/system/openspell-mcp-tunnel.service
}

restore_prior_files() {
  if [[ "$prior_target" == releases/* ]]; then
    sudo ln -sfn "$prior_target" "$release_root/.current-rollback" || return 1
    sudo mv -Tf "$release_root/.current-rollback" "$current_link" || return 1
    prior_revision="$(sudo cat "$release_root/$prior_target/REVISION" 2>/dev/null || true)"
    [[ "$prior_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || return 1
    verify_release_units "$release_root/$prior_target" || return 1
    install_release_units "$release_root/$prior_target" "$prior_revision" || return 1
  else
    sudo unlink "$current_link" 2>/dev/null || true
    sudo rm -f /etc/systemd/system/openspell-mcp.service \
      /etc/systemd/system/openspell-mcp-tunnel.service || return 1
  fi
}

if ! verify_release_manifest "$release_dir"; then
  echo "OpenSpell MCP retained unit manifest failed before activation" >&2
  exit 1
fi
if [[ "$prior_target" == releases/* ]] \
  && ! verify_release_units "$release_root/$prior_target"; then
  echo "refusing activation: prior release cannot provide a verified rollback unit set" >&2
  exit 1
fi

next_link="$release_root/.current-$expected_revision"
sudo ln -sfn "releases/$expected_revision" "$next_link"
sudo mv -Tf "$next_link" "$current_link"
if ! verify_release_units "$release_dir"; then
  if ! restore_prior_files; then
    sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
      >/dev/null 2>&1 || true
    echo "OpenSpell MCP unit verification failed; manual recovery is required" >&2
    exit 1
  fi
  echo "OpenSpell MCP unit verification failed before activation" >&2
  exit 1
fi
if ! install_release_units "$release_dir" "$expected_revision"; then
  if ! restore_prior_files; then
    sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
      >/dev/null 2>&1 || true
    echo "OpenSpell MCP unit installation failed; manual recovery is required" >&2
    exit 1
  fi
  echo "OpenSpell MCP unit installation failed before activation" >&2
  exit 1
fi

rollback_activation() {
  sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
    >/dev/null 2>&1 || true
  restore_prior_files || return 1
  if [[ "$prior_target" == releases/* ]]; then
    sudo systemctl daemon-reload || return 1
    sudo systemctl enable openspell-mcp.service openspell-mcp-tunnel.service \
      || return 1
    sudo systemctl restart openspell-mcp.service || return 1
    sudo systemctl restart openspell-mcp-tunnel.service || return 1
  else
    sudo systemctl disable openspell-mcp-tunnel.service openspell-mcp.service \
      >/dev/null 2>&1 || true
    sudo systemctl daemon-reload || return 1
  fi
}

if ! sudo systemctl daemon-reload \
  || ! sudo systemctl enable openspell-mcp.service openspell-mcp-tunnel.service \
  || ! sudo systemctl restart openspell-mcp.service \
  || ! sudo systemctl restart openspell-mcp-tunnel.service \
  || ! /usr/local/bin/node "$release_root/current/bin/openspell-mcp-health.mjs" \
    https://mcp.ecomwizards.agency/healthz "$expected_revision" 120; then
  if rollback_activation; then
    echo "OpenSpell MCP activation failed; the prior deployment was restored" >&2
  else
    sudo systemctl stop openspell-mcp-tunnel.service openspell-mcp.service \
      >/dev/null 2>&1 || true
    echo "OpenSpell MCP activation failed; services remain stopped for manual recovery" >&2
  fi
  exit 1
fi

echo "activated OpenSpell MCP release $expected_revision"
