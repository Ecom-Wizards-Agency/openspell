#!/usr/bin/env bash
set -euo pipefail

expected_revision=
claim_set='creative.sync,report.request'
claim_set+=',report.poll,report.fetch'
while (($# > 0)); do
  case "$1" in
    --revision)
      expected_revision="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 --revision <full-git-object-id>" >&2
      exit 2
      ;;
  esac
done
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing deployment: --revision must be a full lowercase Git object id" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
source "$script_dir/report-worker-evo-systemd-lib.sh"
report_worker_script_dir="$script_dir"
build_root=
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
  release_report_worker_deployment_lock
}
trap cleanup EXIT

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
for command in diff find flock git pnpm readlink rg rsync sha256sum sort sudo systemd-analyze; do
  command -v "$command" >/dev/null || {
    echo "refusing deployment: required command is unavailable: $command" >&2
    exit 1
  }
done

acquire_report_worker_deployment_lock

build_root="$(mktemp -d /tmp/openspell-report-worker-install.XXXXXX)"

pnpm --dir "$repo_root" install --frozen-lockfile >"$build_root/install.log" 2>&1
bash "$script_dir/test-report-worker-evo-systemd.sh"

post_harness_status="$(git -C "$repo_root" status --porcelain --untracked-files=normal)"
if [[ -n "$post_harness_status" ]]; then
  echo "refusing deployment: dependency install or deployment harness changed the checkout" >&2
  exit 1
fi

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
WORKER_CLAIM_PROTOCOL=fenced
EOF
install -d -m 0755 "$release_stage/bin" "$release_stage/systemd"
install -m 0644 "$script_dir/openspell-report-worker-contract.mjs" \
  "$release_stage/bin/openspell-report-worker-contract.mjs"
install -m 0644 "$script_dir/openspell-report-worker-launch.mjs" \
  "$release_stage/bin/openspell-report-worker-launch.mjs"
install -m 0644 "$script_dir/openspell-report-worker-health.mjs" \
  "$release_stage/bin/openspell-report-worker-health.mjs"
install -m 0644 "$script_dir/openspell-report-worker-readiness.mjs" \
  "$release_stage/bin/openspell-report-worker-readiness.mjs"
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

if ! verify_report_worker_artifact "$release_stage" "$expected_revision"; then
  echo "refusing deployment: staged artifact failed its retained manifest" >&2
  exit 1
fi

release_root="$report_worker_release_root"
release_dir="$release_root/releases/$expected_revision"
incoming_release="$release_root/releases/.incoming-$expected_revision-$$"
if sudo test -e "$release_dir"; then
  if ! verify_report_worker_artifact "$release_dir" "$expected_revision" true; then
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
echo "current, systemd units, enablement, and service state were not changed"
