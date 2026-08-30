#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit="$script_dir/openspell-report-worker.service"
installer="$script_dir/install-report-worker-evo-systemd.sh"
rollback="$script_dir/rollback-report-worker-evo-systemd.sh"
launcher="$script_dir/openspell-report-worker-launch.mjs"
contract="$script_dir/openspell-report-worker-contract.mjs"
health="$script_dir/openspell-report-worker-health.mjs"
verifier="$script_dir/verify-report-worker-evo-systemd.sh"
normalizer="$script_dir/normalize-report-worker-evo-artifact.mjs"

for script in "$installer" "$rollback" "$verifier" "$0"; do
  bash -n "$script"
done
for script in "$launcher" "$contract" "$health" "$normalizer"; do
  node --check "$script"
done

require_line() {
  local file="$1"
  local line="$2"
  if ! grep -Fqx "$line" "$file"; then
    echo "missing invariant in $(basename "$file"): $line" >&2
    exit 1
  fi
}

require_line "$unit" "DynamicUser=yes"
require_line "$unit" "Type=exec"
require_line "$unit" "LoadCredentialEncrypted=openspell-report-worker-database-url:/etc/credstore.encrypted/openspell-report-worker-database-url"
require_line "$unit" "LoadCredentialEncrypted=openspell-report-worker-ads-application:/etc/credstore.encrypted/openspell-report-worker-ads-application"
require_line "$unit" "EnvironmentFile=/opt/openspell-report-worker/current/public.conf"
require_line "$unit" "ExecStart=/usr/local/bin/node /opt/openspell-report-worker/current/node_modules/tsx/dist/cli.mjs /opt/openspell-report-worker/current/bin/openspell-report-worker-launch.mjs"
require_line "$unit" "ExecStartPost=/usr/local/bin/node /opt/openspell-report-worker/current/bin/openspell-report-worker-health.mjs http://127.0.0.1:3000/healthz \${OPENSPELL_WORKER_REVISION} 120"
require_line "$unit" "Restart=on-failure"
require_line "$unit" "RestartSteps=6"
require_line "$unit" "ProtectSystem=strict"
require_line "$unit" "ProtectProc=invisible"
require_line "$unit" "CapabilityBoundingSet="

if ! rg -F 'sudo test -L "$credential_path"' "$installer" >/dev/null \
  || ! rg -F 'system Node 22 or newer' "$installer" >/dev/null \
  || ! rg -F 'OPENSPELL_WORKER_REVISION=$expected_revision' "$installer" >/dev/null \
  || ! rg -F 'WORKER_DEPLOYMENT_ROLE=evo-report-lane' "$installer" >/dev/null \
  || ! rg -F 'WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch' \
    "$installer" >/dev/null; then
  echo "revision, credential, role, or claim invariant is missing" >&2
  exit 1
fi
if ! rg -F 'install_release_unit "$release_dir"' "$installer" >/dev/null \
  || ! rg -F 'install_release_unit "$to_target"' "$rollback" >/dev/null \
  || ! rg -F 'ARTIFACT_SHA256' "$installer" "$verifier" "$rollback" >/dev/null; then
  echo "versioned unit or full artifact rollback invariant is missing" >&2
  exit 1
fi
if rg -n -U -- 'install_release_unit[^\n]*(\\\n[^\n]*)?\|\| true' \
  "$installer" "$rollback" \
  || ! rg -F 'service remains stopped for manual recovery' \
    "$installer" "$rollback" >/dev/null; then
  echo "unit restoration is not fail-closed" >&2
  exit 1
fi

# Match the literal activation guard in the installer.
# shellcheck disable=SC2016
stage_prefix="$(sed '/if \[\[ "$activate" != true \]\]/q' "$installer")"
if rg -n -- 'sudo systemctl (start|stop|restart|enable|disable|daemon-reload)|/etc/systemd/system/openspell-report-worker' \
  <<<"$stage_prefix"; then
  echo "staging can mutate a service or live unit" >&2
  exit 1
fi
if rg -n -- 'openspell-mcp|wizard-ads-mcp|cloudflared|docker' \
  "$unit" "$installer" "$rollback" "$launcher" "$contract" "$health" \
  "$verifier" "$normalizer"; then
  echo "report worker deployment can mutate an MCP or connector service" >&2
  exit 1
fi
private_locator_pattern='op:/''/'
for forbidden_pattern in '/home/' "$private_locator_pattern" 'Environment=.*(DATABASE|SECRET|TOKEN)'; do
  if rg -n -- "$forbidden_pattern" \
    "$unit" "$installer" "$rollback" "$launcher" "$contract" "$health" \
    "$verifier" "$normalizer"; then
    echo "deployment files contain a private path, locator, or inline secret" >&2
    exit 1
  fi
done

test_tmp="$(mktemp -d /tmp/openspell-report-worker-test.XXXXXX)"
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  case "$test_tmp" in
    /tmp/openspell-report-worker-test.*)
      find "$test_tmp" -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
fixture_revision=0000000000000000000000000000000000000000
runtime_fixture="$test_tmp/runtime"
credential_fixture="$test_tmp/credentials"
install -d -m 0700 "$runtime_fixture" "$credential_fixture"
printf '%s\n' "$fixture_revision" >"$runtime_fixture/REVISION"
cat >"$runtime_fixture/public.conf" <<EOF
OPENSPELL_WORKER_REVISION=$fixture_revision
WORKER_DEPLOYMENT_ROLE=evo-report-lane
WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch
EOF
printf '%s\n' 'postgres://synthetic.invalid/runtime' \
  >"$credential_fixture/openspell-report-worker-database-url"
node - "$credential_fixture/openspell-report-worker-ads-application" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
const secretKey = ['client', 'Secret'].join('');
fs.writeFileSync(output, JSON.stringify({ clientId: 'synthetic-app', [secretKey]: 'synthetic-value' }));
NODE

node --input-type=module - \
  "$contract" "$runtime_fixture" "$credential_fixture" "$fixture_revision" <<'NODE'
const [contractPath, releaseRoot, credentialDirectory, revision] = process.argv.slice(2);
const { resolveReportWorkerRuntime } = await import(`file://${contractPath}`);
const environment = {
  OPENSPELL_WORKER_REVISION: revision,
  WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
  WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
};
const runtime = await resolveReportWorkerRuntime({ releaseRoot, credentialDirectory, environment });
if (runtime.releaseRevision !== revision || !runtime.databaseUrl || !runtime.lwaClientId
  || !runtime.lwaClientSecret) process.exit(1);
NODE

cp "$runtime_fixture/public.conf" "$test_tmp/public.good"
for mode in extra role claims revision; do
  cp "$test_tmp/public.good" "$runtime_fixture/public.conf"
  case "$mode" in
    extra) printf '%s\n' 'PORT=3000' >>"$runtime_fixture/public.conf" ;;
    role) sed -i 's/evo-report-lane/general/' "$runtime_fixture/public.conf" ;;
    claims) sed -i 's/,report.fetch//' "$runtime_fixture/public.conf" ;;
    revision) sed -i "s/$fixture_revision/0000000/" "$runtime_fixture/public.conf" ;;
  esac
  if node --input-type=module - \
    "$contract" "$runtime_fixture" "$credential_fixture" "$fixture_revision" \
    >/dev/null 2>&1 <<'NODE'
const [contractPath, releaseRoot, credentialDirectory, revision] = process.argv.slice(2);
const { resolveReportWorkerRuntime } = await import(`file://${contractPath}`);
await resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment: {
    OPENSPELL_WORKER_REVISION: revision,
    WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
    WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
  },
});
NODE
  then
    echo "runtime contract accepted invalid public configuration: $mode" >&2
    exit 1
  fi
done
cp "$test_tmp/public.good" "$runtime_fixture/public.conf"

find "$credential_fixture/openspell-report-worker-database-url" -delete
if node --input-type=module - \
  "$contract" "$runtime_fixture" "$credential_fixture" "$fixture_revision" \
  >/dev/null 2>&1 <<'NODE'
const [contractPath, releaseRoot, credentialDirectory, revision] = process.argv.slice(2);
const { resolveReportWorkerRuntime } = await import(`file://${contractPath}`);
await resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment: {
    OPENSPELL_WORKER_REVISION: revision,
    WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
    WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
  },
});
NODE
then
  echo "runtime contract accepted a missing database credential" >&2
  exit 1
fi
printf '%s\n' 'postgres://synthetic.invalid/runtime' \
  >"$credential_fixture/openspell-report-worker-database-url"
find "$credential_fixture/openspell-report-worker-ads-application" -delete
if node --input-type=module - \
  "$contract" "$runtime_fixture" "$credential_fixture" "$fixture_revision" \
  >/dev/null 2>&1 <<'NODE'
const [contractPath, releaseRoot, credentialDirectory, revision] = process.argv.slice(2);
const { resolveReportWorkerRuntime } = await import(`file://${contractPath}`);
await resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment: {
    OPENSPELL_WORKER_REVISION: revision,
    WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
    WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
  },
});
NODE
then
  echo "runtime contract accepted a missing Ads application credential" >&2
  exit 1
fi
node - "$credential_fixture/openspell-report-worker-ads-application" <<'NODE'
const fs = require('node:fs');
const output = process.argv[2];
const secretKey = ['client', 'Secret'].join('');
fs.writeFileSync(output, JSON.stringify({
  clientId: 'synthetic-app',
  [secretKey]: 'synthetic-value',
  profileSelector: 'not-allowed',
}));
NODE
if node --input-type=module - \
  "$contract" "$runtime_fixture" "$credential_fixture" "$fixture_revision" \
  >/dev/null 2>&1 <<'NODE'
const [contractPath, releaseRoot, credentialDirectory, revision] = process.argv.slice(2);
const { resolveReportWorkerRuntime } = await import(`file://${contractPath}`);
await resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment: {
    OPENSPELL_WORKER_REVISION: revision,
    WORKER_DEPLOYMENT_ROLE: 'evo-report-lane',
    WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
  },
});
NODE
then
  echo "runtime contract accepted a private Ads selector" >&2
  exit 1
fi

package_fixture() {
  local destination="$1"
  pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
    --filter @wizard-ads/worker deploy "$destination" >/dev/null 2>&1
  local tsx_source esbuild_source platform_link platform_source platform_name
  tsx_source="$(readlink -f "$repo_root/node_modules/tsx")"
  esbuild_source="$(readlink -f "$(dirname "$tsx_source")/esbuild")"
  platform_link="$(find "$(dirname "$esbuild_source")/@esbuild" -mindepth 1 -maxdepth 1 \
    \( -type d -o -type l \) -print -quit)"
  platform_source="$(readlink -f "$platform_link")"
  platform_name="$(basename "$platform_link")"
  install -d "$destination/node_modules/tsx" "$destination/node_modules/esbuild" \
    "$destination/node_modules/@esbuild/$platform_name"
  rsync -aL --delete "$tsx_source/" "$destination/node_modules/tsx/"
  rsync -aL --delete "$esbuild_source/" "$destination/node_modules/esbuild/"
  rsync -aL --delete "$platform_source/" "$destination/node_modules/@esbuild/$platform_name/"
  node "$normalizer" "$destination" >/dev/null
}

package_one="$test_tmp/package-one"
package_two="$test_tmp/package-two"
package_fixture "$package_one"
package_fixture "$package_two"
if ! diff -qr "$package_one" "$package_two" >/dev/null; then
  echo "normalized report worker packaging is not path-independent" >&2
  exit 1
fi
node - "$package_one/WORKSPACE_MANIFEST.json" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (manifest.offered !== 10 || manifest.normalized !== 10
  || manifest.packages.length !== 10
  || !manifest.packages.includes('@wizard-ads/sp-api')) process.exit(1);
NODE
if [[ ! -f "$package_one/node_modules/tsx/dist/cli.mjs" \
  || ! -f "$package_one/node_modules/@wizard-ads/sp-api/src/index.ts" \
  || ! -f "$package_one/src/main.ts" ]]; then
  echo "normalized report worker packaging is incomplete" >&2
  exit 1
fi
if { find "$package_one/src" \( -name '*.test.ts' -o -name '*.integration.test.ts' \
  -o -name __fixtures__ -o -name test-fixtures -o -name testing \) \
  -print -quit; find "$package_one/node_modules/.pnpm" -path '*/node_modules/@wizard-ads/*/src/*' \
  \( -name '*.test.ts' -o -name '*.integration.test.ts' -o -name __fixtures__ \
  -o -name test-fixtures -o -name testing \) -print -quit; } | grep -q .; then
  echo "normalized report worker packaging retained tests or fixtures" >&2
  exit 1
fi
if rg --hidden --no-ignore -I -q -F "$repo_root" "$package_one" \
  || rg --hidden --no-ignore -I -q '/(home|Users)/' "$package_one" \
  || rg --hidden --no-ignore -I -q "$private_locator_pattern" "$package_one" \
  || find "$package_one" -path '*home+*' -print -quit | grep -q .; then
  echo "normalized report worker packaging retained checkout identity" >&2
  exit 1
fi
if find "$package_one" \( -name .git -o -name _local -o -name '*.env' \) \
  -print -quit | grep -q .; then
  echo "normalized report worker packaging retained repository or environment state" >&2
  exit 1
fi
mapfile -d '' -t packaged_workspace_sources < <(
  find "$package_one/node_modules/.pnpm" -type d \
    -path '*/node_modules/@wizard-ads/*/src' -print0
)
if rg --hidden --no-ignore -I -q --pcre2 \
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' \
  "$package_one/src" "${packaged_workspace_sources[@]}"; then
  echo "normalized report worker packaging retained a profile-shaped identifier" >&2
  exit 1
fi
if find "$package_one" \( -type f -o -type d \) -perm /022 -print -quit \
  | grep -q .; then
  echo "normalized report worker packaging retained writable content" >&2
  exit 1
fi
(cd "$package_one" && node node_modules/tsx/dist/cli.mjs -e \
  '(async () => { await import("./src/index.ts"); await import("@wizard-ads/sp-api"); })()')

manifest_fixture="$test_tmp/package-manifest"
install -d "$manifest_fixture"
cp -a "$package_one/." "$manifest_fixture/"
(cd "$manifest_fixture" && find . -type l -printf '%P\t%l\n' \
  | LC_ALL=C sort >ARTIFACT_LINKS)
(cd "$manifest_fixture" && find . -type d -printf '%P\n' \
  | LC_ALL=C sort >ARTIFACT_DIRECTORIES)
manifest_directories="$(find "$manifest_fixture" -type d | wc -l)"
manifest_files_before="$(find "$manifest_fixture" -type f | wc -l)"
manifest_links="$(find "$manifest_fixture" -type l | wc -l)"
cat >"$manifest_fixture/ARTIFACT_COUNTS" <<EOF
directories=$manifest_directories
files=$((manifest_files_before + 2))
symlinks=$manifest_links
EOF
manifest_sha_stage="$test_tmp/ARTIFACT_SHA256"
(cd "$manifest_fixture" && find . -type f -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum >"$manifest_sha_stage")
mv "$manifest_sha_stage" "$manifest_fixture/ARTIFACT_SHA256"
(cd "$manifest_fixture" && sha256sum -c ARTIFACT_SHA256 >/dev/null)
printf '\n' >>"$manifest_fixture/package.json"
if (cd "$manifest_fixture" && sha256sum -c ARTIFACT_SHA256 >/dev/null 2>&1); then
  echo "artifact manifest accepted a modified runtime file" >&2
  exit 1
fi

stray_fixture="$test_tmp/package-stray"
pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/worker deploy "$stray_fixture" >/dev/null 2>&1
touch "$stray_fixture/.env"
if node "$normalizer" "$stray_fixture" >/dev/null 2>&1; then
  echo "normalizer accepted a stray environment file" >&2
  exit 1
fi

missing_fixture="$test_tmp/package-missing"
pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/worker deploy "$missing_fixture" >/dev/null 2>&1
missing_spapi="$(find "$missing_fixture/node_modules/.pnpm" -maxdepth 1 -type d \
  -name '@wizard-ads+sp-api@file+*' -print -quit)"
find "$missing_spapi" -depth -delete
if node "$normalizer" "$missing_fixture" >/dev/null 2>&1; then
  echo "normalizer accepted an artifact without sp-api" >&2
  exit 1
fi

link_fixture="$test_tmp/package-link"
pnpm --dir "$repo_root" --config.inject-workspace-packages=true \
  --filter @wizard-ads/worker deploy "$link_fixture" >/dev/null 2>&1
ln -s "$test_tmp/outside" "$link_fixture/src/escaping-link"
if node "$normalizer" "$link_fixture" >/dev/null 2>&1; then
  echo "normalizer accepted an unresolved or escaping symlink" >&2
  exit 1
fi

if bash "$installer" --revision 0000000 >/dev/null 2>&1; then
  echo "installer accepted an abbreviated revision" >&2
  exit 1
fi
wrong_revision=1111111111111111111111111111111111111111
if bash "$installer" --revision "$wrong_revision" >/dev/null 2>&1; then
  echo "installer accepted a mismatched revision" >&2
  exit 1
fi
dirty_probe="$repo_root/.wp172-dirty-probe"
touch "$dirty_probe"
if bash "$installer" --revision "$(git -C "$repo_root" rev-parse HEAD)" \
  >"$test_tmp/dirty.out" 2>&1; then
  echo "installer accepted a dirty checkout" >&2
  find "$dirty_probe" -delete
  exit 1
fi
find "$dirty_probe" -delete
if ! rg -F 'checkout is not clean' "$test_tmp/dirty.out" >/dev/null; then
  echo "installer did not fail at the dirty-checkout boundary" >&2
  exit 1
fi

install -d -m 0700 "$test_tmp/systemd"
sed -e '/^EnvironmentFile=/d' \
  -e '/^LoadCredentialEncrypted=/d' \
  -e 's#^ExecStart=.*#ExecStart=/bin/true#' \
  -e 's#^ExecStartPost=.*#ExecStartPost=/bin/true#' \
  "$unit" >"$test_tmp/systemd/openspell-report-worker.service"
systemd-analyze verify "$test_tmp/systemd/openspell-report-worker.service"

node -e '
  const http = require("node:http");
  const revision = process.argv[1];
  const server = http.createServer((request, response) => {
    const mode = new URL(request.url, "http://fixture.invalid").searchParams.get("mode");
    const jobTypes = ["creative.sync", "report.request", "report.poll", "report.fetch"];
    const body = {
      status: "ok",
      worker: { stopping: false, running: 0 },
      deployment: {
        revision,
        role: mode === "role" ? "general" : "evo-report-lane",
        jobTypes: mode === "claims" ? jobTypes.slice(1) : jobTypes,
      },
      components: { marketingStream: { enabled: false, running: false, stopping: false } },
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
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
for mode in role claims; do
  if node "$health" "http://127.0.0.1:$port/healthz?mode=$mode" \
    "$fixture_revision" 1 >/dev/null 2>&1; then
    echo "health verifier accepted a wrong $mode" >&2
    exit 1
  fi
done
if node "$health" "http://127.0.0.1:$port/healthz" \
  1111111111111111111111111111111111111111 1 >/dev/null 2>&1; then
  echo "health verifier accepted the wrong revision" >&2
  exit 1
fi
if node "$health" "http://127.0.0.1:$port/healthz" 0000000 1 >/dev/null 2>&1; then
  echo "health verifier accepted an abbreviated revision" >&2
  exit 1
fi

echo "OpenSpell report worker systemd deployment invariants passed"
