#!/usr/bin/env bash
set -euo pipefail

expected_revision=
activate=false
claim_set='creative.sync,report.request'
claim_set+=',report.poll,report.fetch'
while (($# > 0)); do
  case "$1" in
    --revision)
      expected_revision="${2:-}"
      shift 2
      ;;
    --activate)
      activate=true
      shift
      ;;
    *)
      echo "usage: $0 --revision <full-git-object-id> [--activate]" >&2
      exit 2
      ;;
  esac
done
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing deployment: --revision must be a full lowercase Git object id" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
actual_revision="$(git -C "$repo_root" rev-parse HEAD)"
if [[ "$actual_revision" != "$expected_revision" ]]; then
  echo "refusing deployment: checkout does not match the approved revision" >&2
  exit 1
fi
if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
  echo "refusing deployment: checkout is not clean" >&2
  exit 1
fi
origin_revision="$(git -C "$repo_root" rev-parse --verify refs/remotes/origin/main)"
if [[ "$origin_revision" != "$expected_revision" ]]; then
  echo "refusing deployment: approved revision is not the current origin/main" >&2
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
for command in diff find git pnpm readlink rg rsync sha256sum sort sudo systemctl systemd-analyze; do
  command -v "$command" >/dev/null || {
    echo "refusing deployment: required command is unavailable: $command" >&2
    exit 1
  }
done

credential_store=/etc/credstore.encrypted
credential_ids=(
  openspell-report-worker-database-url
  openspell-report-worker-ads-application
)
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

bash "$script_dir/test-report-worker-evo-systemd.sh"

build_root="$(mktemp -d /tmp/openspell-report-worker-install.XXXXXX)"
incoming_release=
cleanup() {
  case "$build_root" in
    /tmp/openspell-report-worker-install.*)
      find "$build_root" -depth -delete 2>/dev/null || true
      ;;
  esac
  case "$incoming_release" in
    /opt/openspell-report-worker/releases/.incoming-*)
      sudo find "$incoming_release" -xdev -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

pnpm --dir "$repo_root" install --frozen-lockfile >"$build_root/install.log" 2>&1
release_stage="$build_root/release"
if ! pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/worker deploy "$release_stage" \
  >"$build_root/package.log" 2>&1; then
  echo "refusing deployment: report worker release packaging failed" >&2
  exit 1
fi

tsx_source="$(readlink -f "$repo_root/node_modules/tsx" 2>/dev/null || true)"
esbuild_source="$(readlink -f "$(dirname "$tsx_source")/esbuild" 2>/dev/null || true)"
if [[ ! -f "$tsx_source/package.json" || ! -f "$esbuild_source/package.json" ]]; then
  echo "refusing deployment: pinned TypeScript runtime is incomplete" >&2
  exit 1
fi
mapfile -t esbuild_platforms < <(
  find "$(dirname "$esbuild_source")/@esbuild" -mindepth 1 -maxdepth 1 \
    \( -type d -o -type l \) -printf '%p\n' 2>/dev/null
)
if ((${#esbuild_platforms[@]} != 1)); then
  echo "refusing deployment: expected one host-specific esbuild runtime" >&2
  exit 1
fi
platform_source="$(readlink -f "${esbuild_platforms[0]}" 2>/dev/null || true)"
platform_name="$(basename "${esbuild_platforms[0]}")"
if [[ ! -f "$platform_source/package.json" || ! "$platform_name" =~ ^[a-z0-9_-]+$ ]]; then
  echo "refusing deployment: host-specific esbuild runtime is invalid" >&2
  exit 1
fi

install -d -m 0755 "$release_stage/node_modules/tsx" \
  "$release_stage/node_modules/esbuild" \
  "$release_stage/node_modules/@esbuild/$platform_name"
rsync -aL --delete "$tsx_source/" "$release_stage/node_modules/tsx/"
rsync -aL --delete "$esbuild_source/" "$release_stage/node_modules/esbuild/"
rsync -aL --delete "$platform_source/" \
  "$release_stage/node_modules/@esbuild/$platform_name/"

if ! "$node_runtime" "$script_dir/normalize-report-worker-evo-artifact.mjs" \
  "$release_stage" >"$build_root/normalize.log" 2>&1; then
  echo "refusing deployment: report worker artifact normalization failed" >&2
  exit 1
fi
if [[ ! -f "$release_stage/node_modules/tsx/dist/cli.mjs" \
  || ! -f "$release_stage/node_modules/esbuild/package.json" \
  || ! -f "$release_stage/node_modules/@esbuild/$platform_name/package.json" \
  || ! -f "$release_stage/src/main.ts" \
  || ! -f "$release_stage/node_modules/@wizard-ads/sp-api/src/index.ts" ]]; then
  echo "refusing deployment: packaged report worker runtime is incomplete" >&2
  exit 1
fi

"$node_runtime" - \
  "$release_stage/node_modules/tsx/package.json" \
  "$release_stage/node_modules/esbuild/package.json" \
  "$release_stage/node_modules/@esbuild/$platform_name/package.json" \
  "$release_stage/TYPESCRIPT_RUNTIME.json" <<'NODE'
const fs = require('node:fs');
const [tsxPath, esbuildPath, platformPath, outputPath] = process.argv.slice(2);
const packages = [tsxPath, esbuildPath, platformPath].map((path) => {
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  return { name: value.name, version: value.version };
});
const manifest = { schemaVersion: 1, offered: 3, copied: packages.length, packages };
if (manifest.copied !== manifest.offered
  || packages[0]?.name !== 'tsx'
  || packages[1]?.name !== 'esbuild'
  || !packages[2]?.name?.startsWith('@esbuild/')) process.exit(1);
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
NODE

printf '%s\n' "$expected_revision" >"$release_stage/REVISION"
cat >"$release_stage/public.conf" <<EOF
OPENSPELL_WORKER_REVISION=$expected_revision
WORKER_DEPLOYMENT_ROLE=evo-report-lane
WORKER_JOB_TYPES=$claim_set
EOF
install -d -m 0755 "$release_stage/bin" "$release_stage/systemd"
install -m 0644 "$script_dir/openspell-report-worker-contract.mjs" \
  "$release_stage/bin/openspell-report-worker-contract.mjs"
install -m 0644 "$script_dir/openspell-report-worker-launch.mjs" \
  "$release_stage/bin/openspell-report-worker-launch.mjs"
install -m 0644 "$script_dir/openspell-report-worker-health.mjs" \
  "$release_stage/bin/openspell-report-worker-health.mjs"
install -m 0644 "$script_dir/openspell-report-worker.service" \
  "$release_stage/systemd/openspell-report-worker.service"
chmod 0644 "$release_stage/REVISION" "$release_stage/public.conf"

private_locator_pattern='op:/''/'
if rg --hidden --no-ignore -I -q -F "$repo_root" "$release_stage" \
  || rg --hidden --no-ignore -I -q "/(home|Users)/|$private_locator_pattern" "$release_stage" \
  || find "$release_stage" -path '*home+*' -print -quit | grep -q .; then
  echo "refusing deployment: packaged runtime retains a checkout or private locator" >&2
  exit 1
fi
if find "$release_stage" \( -name .git -o -name _local -o -name '*.env' \) \
  -print -quit | grep -q .; then
  echo "refusing deployment: packaged runtime contains a private or environment file" >&2
  exit 1
fi
mapfile -d '' -t workspace_source_roots < <(
  find "$release_stage/node_modules/.pnpm" -type d \
    -path '*/node_modules/@wizard-ads/*/src' -print0
)
if rg --hidden --no-ignore -I -q --pcre2 \
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' \
  "$release_stage/src" "${workspace_source_roots[@]}"; then
  echo "refusing deployment: packaged runtime contains a profile-shaped identifier" >&2
  exit 1
fi
if find "$release_stage" \( -type f -o -type d \) -perm /022 -print -quit \
  | grep -q .; then
  echo "refusing deployment: packaged runtime contains writable content" >&2
  exit 1
fi
while IFS= read -r -d '' link_path; do
  resolved="$(readlink -f "$link_path" 2>/dev/null || true)"
  case "$resolved" in
    "$release_stage"/*) ;;
    *)
      echo "refusing deployment: packaged runtime contains an unresolved or external symlink" >&2
      exit 1
      ;;
  esac
done < <(find "$release_stage" -type l -print0)

(cd "$release_stage" && find . -type l -printf '%P\t%l\n' \
  | LC_ALL=C sort >ARTIFACT_LINKS)
(cd "$release_stage" && find . -type d -printf '%P\n' \
  | LC_ALL=C sort >ARTIFACT_DIRECTORIES)
directory_count="$(find "$release_stage" -type d | wc -l)"
file_count_before_manifests="$(find "$release_stage" -type f | wc -l)"
link_count="$(find "$release_stage" -type l | wc -l)"
cat >"$release_stage/ARTIFACT_COUNTS" <<EOF
directories=$directory_count
files=$((file_count_before_manifests + 2))
symlinks=$link_count
EOF
artifact_sha_stage="$build_root/ARTIFACT_SHA256"
(cd "$release_stage" && find . -type f -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum >"$artifact_sha_stage")
mv "$artifact_sha_stage" "$release_stage/ARTIFACT_SHA256"
chmod 0644 "$release_stage/ARTIFACT_COUNTS" "$release_stage/ARTIFACT_DIRECTORIES" \
  "$release_stage/ARTIFACT_LINKS" \
  "$release_stage/ARTIFACT_SHA256" "$release_stage/TYPESCRIPT_RUNTIME.json"

verify_artifact() {
  local release="$1"
  local expected="$2"
  local counts actual_directories actual_files actual_links directory_fixture link_fixture
  [[ "$(cat "$release/REVISION" 2>/dev/null || true)" == "$expected" ]] || return 1
  [[ "$(cat "$release/public.conf" 2>/dev/null || true)" == \
    "OPENSPELL_WORKER_REVISION=$expected"$'\n'"WORKER_DEPLOYMENT_ROLE=evo-report-lane"$'\n'"WORKER_JOB_TYPES=$claim_set" ]] \
    || return 1
  (cd "$release" && sha256sum -c ARTIFACT_SHA256 >/dev/null) || return 1
  counts="$(cat "$release/ARTIFACT_COUNTS" 2>/dev/null || true)"
  actual_directories="$(find "$release" -type d | wc -l)"
  actual_files="$(find "$release" -type f | wc -l)"
  actual_links="$(find "$release" -type l | wc -l)"
  [[ "$counts" == "directories=$actual_directories"$'\n'"files=$actual_files"$'\n'"symlinks=$actual_links" ]] \
    || return 1
  if find "$release" \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
    return 1
  fi
  directory_fixture="$(mktemp "$build_root/directories.XXXXXX")"
  (cd "$release" && find . -type d -printf '%P\n' | LC_ALL=C sort >"$directory_fixture")
  diff -u "$release/ARTIFACT_DIRECTORIES" "$directory_fixture" >/dev/null || return 1
  link_fixture="$(mktemp "$build_root/links.XXXXXX")"
  (cd "$release" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort >"$link_fixture")
  diff -u "$release/ARTIFACT_LINKS" "$link_fixture" >/dev/null || return 1
  while IFS= read -r -d '' link_path; do
    case "$(readlink -f "$link_path" 2>/dev/null || true)" in
      "$release"/*) ;;
      *) return 1 ;;
    esac
  done < <(find "$release" -type l -print0)
}

if ! verify_artifact "$release_stage" "$expected_revision"; then
  echo "refusing deployment: staged artifact failed its retained manifest" >&2
  exit 1
fi

release_root=/opt/openspell-report-worker
release_dir="$release_root/releases/$expected_revision"
incoming_release="$release_root/releases/.incoming-$expected_revision-$$"
if sudo test -e "$release_dir"; then
  if ! verify_artifact "$release_dir" "$expected_revision"; then
    echo "refusing deployment: retained release has invalid provenance" >&2
    exit 1
  fi
else
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
if sudo find "$release_dir" -xdev \( ! -user root -o ! -group root \) -print -quit \
  | grep -q .; then
  echo "refusing deployment: installed release is not root-owned" >&2
  exit 1
fi

echo "staged OpenSpell report worker release $expected_revision"
if [[ "$activate" != true ]]; then
  echo "current, systemd units, enablement, and service state were not changed"
  exit 0
fi

current_link="$release_root/current"
prior_target="$(sudo readlink "$current_link" 2>/dev/null || true)"
if [[ -n "$prior_target" && ! "$prior_target" =~ ^releases/[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing activation: current release link has invalid provenance" >&2
  exit 1
fi
if [[ -z "$prior_target" ]] && sudo test -e /etc/systemd/system/openspell-report-worker.service; then
  echo "refusing activation: an unversioned report worker unit already exists" >&2
  exit 1
fi
prior_active=false
prior_enabled=false
systemctl is-active --quiet openspell-report-worker.service 2>/dev/null && prior_active=true
systemctl is-enabled --quiet openspell-report-worker.service 2>/dev/null && prior_enabled=true

verify_release_unit() {
  local release="$1"
  sudo systemd-analyze verify "$release/systemd/openspell-report-worker.service"
}
install_release_unit() {
  local release="$1"
  local suffix="$2"
  local staged_unit="/etc/systemd/system/.openspell-report-worker.service.$suffix"
  sudo install -m 0644 -o root -g root \
    "$release/systemd/openspell-report-worker.service" "$staged_unit" \
    && sudo mv -Tf "$staged_unit" /etc/systemd/system/openspell-report-worker.service
}
switch_link() {
  local target="$1"
  local next_link="$release_root/.current-switch"
  sudo ln -sfn "$target" "$next_link"
  sudo mv -Tf "$next_link" "$current_link"
}
restore_prior() {
  sudo systemctl stop openspell-report-worker.service >/dev/null 2>&1 || true
  if [[ "$prior_target" == releases/* ]]; then
    switch_link "$prior_target" || return 1
    verify_release_unit "$release_root/$prior_target" || return 1
    install_release_unit "$release_root/$prior_target" rollback || return 1
  else
    sudo unlink "$current_link" 2>/dev/null || true
    sudo unlink /etc/systemd/system/openspell-report-worker.service 2>/dev/null || true
  fi
  sudo systemctl daemon-reload || return 1
  if [[ "$prior_enabled" == true ]]; then
    sudo systemctl enable openspell-report-worker.service >/dev/null || return 1
  else
    sudo systemctl disable openspell-report-worker.service >/dev/null 2>&1 || true
  fi
  if [[ "$prior_active" == true ]]; then
    sudo systemctl restart openspell-report-worker.service || return 1
  fi
}

if [[ "$prior_target" == releases/* ]]; then
  prior_revision="$(sudo cat "$release_root/$prior_target/REVISION" 2>/dev/null || true)"
  if [[ ! "$prior_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] \
    || ! verify_release_unit "$release_root/$prior_target"; then
    echo "refusing activation: prior release cannot provide a verified rollback" >&2
    exit 1
  fi
fi
if ! verify_release_unit "$release_dir"; then
  echo "refusing activation: staged release unit is invalid" >&2
  exit 1
fi

switch_link "releases/$expected_revision"
if ! install_release_unit "$release_dir" "$expected_revision" \
  || ! sudo systemctl daemon-reload \
  || ! sudo systemctl enable openspell-report-worker.service >/dev/null \
  || ! sudo systemctl restart openspell-report-worker.service \
  || ! "$node_runtime" "$release_root/current/bin/openspell-report-worker-health.mjs" \
    http://127.0.0.1:3000/healthz "$expected_revision" 120; then
  if restore_prior; then
    echo "OpenSpell report worker activation failed; the prior deployment was restored" >&2
  else
    sudo systemctl stop openspell-report-worker.service >/dev/null 2>&1 || true
    echo "OpenSpell report worker activation failed; service remains stopped for manual recovery" >&2
  fi
  exit 1
fi

echo "activated OpenSpell report worker release $expected_revision"
