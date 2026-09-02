#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit="$script_dir/openspell-report-worker.service"
installer="$script_dir/install-report-worker-evo-systemd.sh"
activator="$script_dir/activate-report-worker-evo-systemd.sh"
rollback="$script_dir/rollback-report-worker-evo-systemd.sh"
launcher="$script_dir/openspell-report-worker-launch.mjs"
contract="$script_dir/openspell-report-worker-contract.mjs"
health="$script_dir/openspell-report-worker-health.mjs"
readiness="$script_dir/openspell-report-worker-readiness.mjs"
readiness_test="$script_dir/test-report-worker-readiness.mjs"
service_state="$script_dir/openspell-report-worker-service-state.mjs"
deployment_lib="$script_dir/report-worker-evo-systemd-lib.sh"
verifier="$script_dir/verify-report-worker-evo-systemd.sh"
normalizer="$script_dir/normalize-report-worker-evo-artifact.mjs"

for script in "$installer" "$activator" "$rollback" "$verifier" "$deployment_lib" "$0"; do
  bash -n "$script"
done
for script in "$launcher" "$contract" "$health" "$readiness" "$readiness_test" \
  "$service_state" "$normalizer"; do
  node --check "$script"
done
node "$script_dir/../../node_modules/tsx/dist/cli.mjs" "$readiness_test"

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
require_line "$unit" "RestartPreventExitStatus=78"
require_line "$unit" "RestartSteps=6"
require_line "$unit" "ProtectSystem=strict"
require_line "$unit" "ProtectProc=invisible"
require_line "$unit" "CapabilityBoundingSet="

readiness_line="$(rg -n -F 'await verifyReportWorkerDatabaseReadiness' "$launcher" | cut -d: -f1)"
startup_gate_line="$(rg -n -F 'await verifyReportWorkerStartupGate' "$launcher" | cut -d: -f1)"
worker_import_line="$(rg -n -F "await import(new URL('../src/main.ts'" "$launcher" | cut -d: -f1)"
if [[ -z "$readiness_line" || -z "$startup_gate_line" || -z "$worker_import_line" \
  || "$readiness_line" -ge "$startup_gate_line" \
  || "$startup_gate_line" -ge "$worker_import_line" ]] \
  || ! rg -F 'process.exit(78)' "$launcher" >/dev/null \
  || ! rg -F "process.env.WORKER_HEALTH_HOST = '127.0.0.1'" "$launcher" >/dev/null; then
  echo "database readiness, nonrestart startup gate, or loopback health is not enforced before worker import" >&2
  exit 1
fi

if ! rg -F 'test -L "$credential_path"' "$deployment_lib" >/dev/null \
  || ! rg -F 'system Node 22 or newer' "$installer" >/dev/null \
  || ! rg -F 'OPENSPELL_WORKER_REVISION=$expected_revision' "$installer" >/dev/null \
  || ! rg -F 'WORKER_DEPLOYMENT_ROLE=evo-report-lane' "$installer" >/dev/null \
  || ! rg -F 'WORKER_JOB_TYPES=$claim_set' \
    "$installer" >/dev/null \
  || ! rg -F 'WORKER_CLAIM_PROTOCOL=fenced' "$installer" >/dev/null \
  || ! rg -F 'WORKER_CLAIM_BATCH_SIZE=1' "$installer" >/dev/null \
  || ! rg -F 'WORKER_MAX_CONCURRENT_JOBS=1' "$installer" >/dev/null; then
  echo "revision, credential, role, claim, protocol, or concurrency invariant is missing" >&2
  exit 1
fi
if ! rg -F 'install_report_worker_unit "$release"' "$activator" >/dev/null \
  || ! rg -F 'install_report_worker_unit "$destination"' "$rollback" >/dev/null \
  || ! rg -F 'ARTIFACT_SHA256' "$installer" "$deployment_lib" >/dev/null; then
  echo "versioned unit or full artifact rollback invariant is missing" >&2
  exit 1
fi
if rg -n -U -- 'install_report_worker_unit[^\n]*(\\\n[^\n]*)?\|\| true' \
  "$activator" "$rollback" "$deployment_lib" \
  || rg -n -- 'systemctl (stop|disable).*\|\| true' \
    "$activator" "$rollback" "$deployment_lib" \
  || ! rg -F 'inactive and disabled for attended recovery' \
    "$activator" "$rollback" >/dev/null; then
  echo "unit restoration is not fail-closed" >&2
  exit 1
fi

if rg -n -- 'sudo systemctl (start|stop|restart|enable|disable|daemon-reload)|/etc/systemd/system/openspell-report-worker' \
  "$installer"; then
  echo "staging can mutate a service or live unit" >&2
  exit 1
fi
if rg -F 'verify_report_worker_credentials' "$installer" >/dev/null; then
  echo "staging depends on live credentials" >&2
  exit 1
fi
unique_installer_line() {
  local needle="$1"
  local label="$2"
  local -a matches
  local source_line
  mapfile -t matches < <(rg -n -F -- "$needle" "$installer" | cut -d: -f1)
  if ((${#matches[@]} != 1)); then
    echo "installer must contain exactly one executable $label boundary" >&2
    exit 1
  fi
  source_line="$(sed -n "${matches[0]}p" "$installer")"
  if [[ "$source_line" =~ ^[[:space:]]*# ]]; then
    echo "installer $label boundary cannot be a comment" >&2
    exit 1
  fi
  printf '%s\n' "${matches[0]}"
}
trap_line="$(unique_installer_line 'trap cleanup EXIT' 'cleanup')"
lock_line="$(unique_installer_line 'acquire_report_worker_deployment_lock' 'lock')"
mktemp_line="$(unique_installer_line 'build_root="$(mktemp -d' 'temporary allocation')"
install_line="$(unique_installer_line 'pnpm --dir "$repo_root" install --frozen-lockfile' 'dependency install')"
harness_line="$(unique_installer_line 'bash "$script_dir/test-report-worker-evo-systemd.sh"' 'harness')"
clean_line="$(unique_installer_line 'post_harness_status="$(git -C "$repo_root" status' 'post-harness cleanliness')"
package_line="$(unique_installer_line '--filter @wizard-ads/worker deploy "$release_stage"' 'release packaging')"
if [[ "$trap_line" -ge "$lock_line" || "$lock_line" -ge "$mktemp_line" \
  || "$mktemp_line" -ge "$install_line" || "$install_line" -ge "$harness_line" \
  || "$harness_line" -ge "$clean_line" || "$clean_line" -ge "$package_line" ]]; then
  echo "installer cleanup, lock, install, harness, cleanliness, and packaging are ordered unsafely" >&2
  exit 1
fi
if ! rg -F -- '--vercel-report-claims-relinquished' "$activator" >/dev/null \
  || ! rg -F 'assert_legacy_report_worker_retired' "$activator" "$rollback" "$verifier" >/dev/null \
  || ! rg -F 'restore_report_worker_state_if_unchanged' "$activator" "$rollback" >/dev/null \
  || ! rg -F 'verify_report_worker_fenced_protocol' "$activator" "$rollback" >/dev/null \
  || ! rg -F 'verify_report_worker_database_contract' "$activator" "$rollback" >/dev/null \
  || ! rg -F 'verify_report_worker_fenced_authority' \
    "$activator" "$rollback" "$verifier" >/dev/null \
  || ! rg -F 'activate_report_worker_fenced_authority' "$activator" >/dev/null \
  || ! rg -F 'capture_report_worker_custody_snapshot' "$activator" "$rollback" >/dev/null \
  || ! rg -F 'assert_report_worker_exact_absence' "$activator" >/dev/null \
  || ! rg -F 'verify_report_worker_live' "$deployment_lib" "$activator" "$rollback" "$verifier" >/dev/null; then
  echo "claim handoff, fenced destination, custody, or recovery proof is missing" >&2
  exit 1
fi
if rg -n -F 'systemctl restart "$report_worker_service"' \
  "$activator" "$rollback" "$deployment_lib"; then
  echo "report worker transition may restart without a custody proof" >&2
  exit 1
fi
for transition in "$activator" "$rollback"; do
  stop_line="$(rg -n -F 'stop_report_worker_and_prove_inactive' "$transition" | tail -1 | cut -d: -f1)"
  custody_line="$(rg -n -F 'custody_before="$(capture_report_worker_custody_snapshot' \
    "$transition" | head -1 | cut -d: -f1)"
  switch_line="$(rg -n -F 'switch_report_worker_link' "$transition" | cut -d: -f1)"
  if [[ -z "$stop_line" || -z "$custody_line" || -z "$switch_line" \
    || "$stop_line" -ge "$custody_line" || "$custody_line" -ge "$switch_line" ]]; then
    echo "$(basename "$transition") does not stop and drain before switching" >&2
    exit 1
  fi
done
activation_authority_line="$(rg -n -F 'activate_report_worker_fenced_authority' "$activator" | cut -d: -f1)"
activation_custody_line="$(rg -n -F 'custody_before="$(capture_report_worker_custody_snapshot' \
  "$activator" | head -1 | cut -d: -f1)"
activation_switch_line="$(rg -n -F 'switch_report_worker_link' "$activator" | cut -d: -f1)"
if [[ -z "$activation_authority_line" || -z "$activation_custody_line" \
  || -z "$activation_switch_line" \
  || "$activation_custody_line" -ge "$activation_authority_line" \
  || "$activation_authority_line" -ge "$activation_switch_line" ]]; then
  echo "activation does not drain, irreversibly fence authority, and then switch" >&2
  exit 1
fi
if rg -ni -- 'restore.*legacy.*authority|legacy.*authority.*restore|activate.*legacy' \
  "$activator" "$rollback" "$deployment_lib"; then
  echo "deployment code contains a reverse authority transition" >&2
  exit 1
fi
if ! rg -F '"$report_worker_script_dir/openspell-report-worker-readiness.mjs"' \
  "$deployment_lib" >/dev/null \
  || ! rg -F '"$report_worker_script_dir/../../node_modules/tsx/dist/cli.mjs"' \
    "$deployment_lib" >/dev/null \
  || rg -F '"$release/node_modules/tsx/dist/cli.mjs"' \
    "$deployment_lib" >/dev/null; then
  echo "deployment transition trusts the candidate release readiness helper" >&2
  exit 1
fi
if ! rg -F 'assert_report_worker_transition_source' \
  "$activator" "$rollback" "$verifier" >/dev/null \
  || ! rg -F 'status --porcelain --untracked-files=normal' "$deployment_lib" >/dev/null \
  || ! rg -F '[[ "$helper_mode" == 100755\ * ]]' "$deployment_lib" >/dev/null; then
  echo "deployment transition does not prove a clean executable tracked helper" >&2
  exit 1
fi
if rg -n -- 'openspell-mcp|wizard-ads-mcp|cloudflared|docker' \
  "$unit" "$installer" "$activator" "$rollback" "$launcher" "$contract" "$health" \
  "$readiness" "$deployment_lib" "$verifier" "$normalizer"; then
  echo "report worker deployment can mutate an MCP or connector service" >&2
  exit 1
fi
private_locator_pattern='op:/''/'
for forbidden_pattern in '/home/' "$private_locator_pattern" 'Environment=HOME=' \
  'Environment=.*(DATABASE|SECRET|TOKEN)'; do
  if rg -n -- "$forbidden_pattern" \
    "$unit" "$installer" "$activator" "$rollback" "$launcher" "$contract" "$health" \
    "$readiness" "$deployment_lib" "$verifier" "$normalizer"; then
    echo "deployment files contain a private path, locator, or inline secret" >&2
    exit 1
  fi
done

test_tmp="$(mktemp -d /tmp/openspell-report-worker-test.XXXXXX)"
server_pid=
dirty_probe=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  if [[ -n "$dirty_probe" ]]; then find "$dirty_probe" -delete 2>/dev/null || true; fi
  case "$test_tmp" in
    /tmp/openspell-report-worker-test.*)
      find "$test_tmp" -depth -delete 2>/dev/null || true
      ;;
  esac
}
trap cleanup EXIT

repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
fixture_revision=0000000000000000000000000000000000000000

(
  # The database transition helper must come from a clean tracked checkout and
  # must retain its executable mode.
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  transition_repo="$test_tmp/transition-repo"
  report_worker_script_dir="$transition_repo/docs/deploy"
  install -d "$report_worker_script_dir"
  install -m 0755 "$readiness" \
    "$report_worker_script_dir/openspell-report-worker-readiness.mjs"
  git -C "$transition_repo" init -q
  git -C "$transition_repo" add docs/deploy/openspell-report-worker-readiness.mjs
  git -C "$transition_repo" -c user.name=fixture -c user.email=fixture@example.invalid \
    commit -qm fixture
  assert_report_worker_transition_source
  transition_revision="$(git -C "$transition_repo" rev-parse HEAD)"
  assert_report_worker_transition_source "$transition_revision"
  if assert_report_worker_transition_source "$fixture_revision"; then
    echo "transition source accepted a mismatched approved revision" >&2
    exit 1
  fi
  printf '%s\n' dirty >"$transition_repo/untracked"
  if assert_report_worker_transition_source; then
    echo "transition source accepted an untracked file" >&2
    exit 1
  fi
  find "$transition_repo/untracked" -delete
  chmod 0644 "$report_worker_script_dir/openspell-report-worker-readiness.mjs"
  git -C "$transition_repo" add docs/deploy/openspell-report-worker-readiness.mjs
  git -C "$transition_repo" -c user.name=fixture -c user.email=fixture@example.invalid \
    commit -qm mode-drop
  if assert_report_worker_transition_source; then
    echo "transition source accepted a non-executable helper" >&2
    exit 1
  fi
)

node --input-type=module - "$service_state" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { assertLegacyReportWorkerRetired, assertReportWorkerAbsent } =
  await import(pathToFileURL(process.argv[2]));
const accepted = [
  'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n',
  'UnitFileState=disabled\nLoadState=loaded\nActiveState=inactive\n',
];
for (const state of accepted) assert.doesNotThrow(() => assertLegacyReportWorkerRetired(state));
assert.doesNotThrow(() => assertReportWorkerAbsent(accepted[0]));
assert.throws(() => assertReportWorkerAbsent(accepted[1]));
const refused = [
  'LoadState=loaded\nActiveState=active\nUnitFileState=disabled\n',
  'LoadState=loaded\nActiveState=inactive\nUnitFileState=enabled\n',
  'LoadState=loaded\nActiveState=failed\nUnitFileState=disabled\n',
  'LoadState=loaded\nActiveState=inactive\nUnitFileState=static\n',
  'LoadState=not-found\nActiveState=inactive\nUnitFileState=disabled\n',
  'LoadState=loaded\nActiveState=inactive\n',
];
for (const state of refused) assert.throws(() => assertLegacyReportWorkerRetired(state));
NODE

(
  # Stopping for recovery must prove both inactivity and disabled state. A failed
  # stop may not be hidden by a later disable, and exact first-activation absence
  # requires no service mutation.
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  service_active=active
  service_enabled=enabled
  fail_stop=false
  fail_disable=false
  exact_absence=false
  transition_log="$test_tmp/service-transition.log"
  assert_report_worker_exact_absence() { [[ "$exact_absence" == true ]]; }
  report_worker_run_privileged() {
    if [[ "$1 $2" == 'systemctl stop' ]]; then
      printf '%s\n' stop >>"$transition_log"
      [[ "$fail_stop" == false ]] || return 1
      service_active=inactive
      return 0
    fi
    if [[ "$1 $2" == 'systemctl disable' ]]; then
      printf '%s\n' disable >>"$transition_log"
      [[ "$fail_disable" == false ]] || return 1
      service_enabled=disabled
      return 0
    fi
    return 91
  }
  systemctl() {
    case "$1" in
      is-active) printf '%s\n' "$service_active" ;;
      is-enabled) printf '%s\n' "$service_enabled" ;;
      *) return 92 ;;
    esac
  }

  exact_absence=true
  leave_report_worker_stopped
  [[ ! -e "$transition_log" ]]

  exact_absence=false
  leave_report_worker_stopped
  printf '%s\n' stop disable >"$test_tmp/service-transition.expected"
  diff -u "$test_tmp/service-transition.expected" "$transition_log"

  : >"$transition_log"
  service_active=active
  service_enabled=enabled
  fail_stop=true
  if leave_report_worker_stopped; then
    echo "recovery accepted a failed service stop" >&2
    exit 1
  fi
  printf '%s\n' stop >"$test_tmp/service-transition.expected"
  diff -u "$test_tmp/service-transition.expected" "$transition_log"

  : >"$transition_log"
  service_active=active
  service_enabled=enabled
  fail_stop=false
  fail_disable=true
  if leave_report_worker_stopped; then
    echo "recovery accepted a failed service disable" >&2
    exit 1
  fi
  printf '%s\n' stop disable >"$test_tmp/service-transition.expected"
  diff -u "$test_tmp/service-transition.expected" "$transition_log"
)

(
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  report_worker_run_privileged() {
    if [[ "$1" == chown ]]; then return 0; fi
    if [[ "$1" == stat ]]; then printf '%s\n' '600:root:root'; return 0; fi
    command "$@"
  }
  lock_fixture="$test_tmp/deployment.lock"
  acquire_report_worker_deployment_lock "$lock_fixture"
  if (
    # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
    source "$deployment_lib"
    report_worker_run_privileged() {
      if [[ "$1" == chown ]]; then return 0; fi
      if [[ "$1" == stat ]]; then printf '%s\n' '600:root:root'; return 0; fi
      command "$@"
    }
    acquire_report_worker_deployment_lock "$lock_fixture"
  ) >/dev/null 2>&1; then
    echo "deployment serialization lock admitted a concurrent operation" >&2
    exit 1
  fi
  release_report_worker_deployment_lock
  acquire_report_worker_deployment_lock "$lock_fixture"
  release_report_worker_deployment_lock
)

(
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  report_worker_release_root="$test_tmp/recovery-root"
  recovery_log="$test_tmp/recovery.log"
  verify_report_worker_release() { printf '%s\n' "verify-release:$2" >>"$recovery_log"; }
  report_worker_run_privileged() { printf '%s\n' "privileged:$*" >>"$recovery_log"; }
  switch_report_worker_link() { printf '%s\n' "switch:$1" >>"$recovery_log"; }
  install_report_worker_unit() { printf '%s\n' "install-unit:$2" >>"$recovery_log"; }
  verify_report_worker_live() { printf '%s\n' "verify-live:$1" >>"$recovery_log"; }
  restore_report_worker_live "$fixture_revision"
  expected_recovery="$test_tmp/recovery.expected"
  cat >"$expected_recovery" <<EOF
verify-release:$fixture_revision
switch:releases/$fixture_revision
install-unit:recovery
privileged:systemctl daemon-reload
privileged:systemctl enable openspell-report-worker.service
privileged:systemctl start openspell-report-worker.service
verify-live:$fixture_revision
EOF
  diff -u "$expected_recovery" "$recovery_log"
  verify_report_worker_live() { return 1; }
  if restore_report_worker_live "$fixture_revision" >/dev/null 2>&1; then
    echo "recovery accepted an unverified restored live deployment" >&2
    exit 1
  fi
)

(
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  recovery_log="$test_tmp/custody-recovery.log"
  restore_report_worker_live() { printf '%s\n' "restore-live:$1" >>"$recovery_log"; }
  restore_report_worker_absence() { printf '%s\n' 'restore-absence' >>"$recovery_log"; }
  drained='{"schemaVersion":1,"unresolved":0,"fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  changed='{"schemaVersion":1,"unresolved":0,"fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  unresolved='{"schemaVersion":1,"unresolved":1,"fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  restore_report_worker_state_if_unchanged "$drained" "$drained" "$fixture_revision"
  restore_report_worker_state_if_unchanged "$drained" "$drained"
  if restore_report_worker_state_if_unchanged "$drained" "$changed" "$fixture_revision"; then
    echo "recovery accepted changed post-start custody" >&2
    exit 1
  fi
  if restore_report_worker_state_if_unchanged "$unresolved" "$unresolved"; then
    echo "first activation restored absence after an unresolved claim" >&2
    exit 1
  fi
  printf '%s\n' "restore-live:$fixture_revision" 'restore-absence' >"$test_tmp/custody.expected"
  diff -u "$test_tmp/custody.expected" "$recovery_log"
)

(
  # Only an exact committed/idempotent authority response permits a switch.
  # An unresolved decision, zero epoch, type spoof, or extra field fails closed.
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  assert_report_worker_authority_activated \
    '{"decision":"activated","epoch":"1","unresolved":0}'
  assert_report_worker_authority_activated \
    '{"decision":"already_fenced","epoch":"2","unresolved":0}'
  for invalid in \
    '{"decision":"unresolved","epoch":"0","unresolved":1}' \
    '{"decision":"activated","epoch":"0","unresolved":0}' \
    '{"decision":"activated","epoch":1,"unresolved":0}' \
    '{"decision":"activated","epoch":"1","unresolved":0,"spoofed":true}'; do
    if assert_report_worker_authority_activated "$invalid"; then
      echo "activation accepted an invalid authority result" >&2
      exit 1
    fi
  done
)

(
  # A rollback destination must independently advertise fenced custody.
  # shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
  source "$deployment_lib"
  protocol_fixture="$test_tmp/protocol-destination"
  install -d "$protocol_fixture"
  cat >"$protocol_fixture/public.conf" <<EOF
OPENSPELL_WORKER_REVISION=$fixture_revision
WORKER_DEPLOYMENT_ROLE=evo-report-lane
WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch
WORKER_CLAIM_PROTOCOL=fenced
WORKER_CLAIM_BATCH_SIZE=1
WORKER_MAX_CONCURRENT_JOBS=1
EOF
  verify_report_worker_release() { return 0; }
  verify_report_worker_fenced_protocol "$protocol_fixture" "$fixture_revision"
  sed -i 's/WORKER_CLAIM_PROTOCOL=fenced/WORKER_CLAIM_PROTOCOL=legacy/' \
    "$protocol_fixture/public.conf"
  if verify_report_worker_fenced_protocol "$protocol_fixture" "$fixture_revision"; then
    echo "rollback compatibility accepted a destination without fenced custody" >&2
    exit 1
  fi
)

runtime_fixture="$test_tmp/runtime"
credential_fixture="$test_tmp/credentials"
install -d -m 0700 "$runtime_fixture" "$credential_fixture"
printf '%s\n' "$fixture_revision" >"$runtime_fixture/REVISION"
cat >"$runtime_fixture/public.conf" <<EOF
OPENSPELL_WORKER_REVISION=$fixture_revision
WORKER_DEPLOYMENT_ROLE=evo-report-lane
WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch
WORKER_CLAIM_PROTOCOL=fenced
WORKER_CLAIM_BATCH_SIZE=1
WORKER_MAX_CONCURRENT_JOBS=1
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
  WORKER_CLAIM_PROTOCOL: 'fenced',
  WORKER_CLAIM_BATCH_SIZE: '1',
  WORKER_MAX_CONCURRENT_JOBS: '1',
};
const runtime = await resolveReportWorkerRuntime({ releaseRoot, credentialDirectory, environment });
if (runtime.releaseRevision !== revision || !runtime.databaseUrl || !runtime.lwaClientId
  || !runtime.lwaClientSecret) process.exit(1);
NODE

cp "$runtime_fixture/public.conf" "$test_tmp/public.good"
for mode in extra role claims revision protocol batch concurrency; do
  cp "$test_tmp/public.good" "$runtime_fixture/public.conf"
  case "$mode" in
    extra) printf '%s\n' 'PORT=3000' >>"$runtime_fixture/public.conf" ;;
    role) sed -i 's/evo-report-lane/general/' "$runtime_fixture/public.conf" ;;
    claims) sed -i 's/,report.fetch//' "$runtime_fixture/public.conf" ;;
    revision) sed -i "s/$fixture_revision/0000000/" "$runtime_fixture/public.conf" ;;
    protocol) sed -i 's/WORKER_CLAIM_PROTOCOL=fenced/WORKER_CLAIM_PROTOCOL=legacy/' "$runtime_fixture/public.conf" ;;
    batch) sed -i 's/WORKER_CLAIM_BATCH_SIZE=1/WORKER_CLAIM_BATCH_SIZE=2/' "$runtime_fixture/public.conf" ;;
    concurrency) sed -i 's/WORKER_MAX_CONCURRENT_JOBS=1/WORKER_MAX_CONCURRENT_JOBS=2/' "$runtime_fixture/public.conf" ;;
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
    WORKER_CLAIM_PROTOCOL: 'fenced',
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_MAX_CONCURRENT_JOBS: '1',
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
    WORKER_CLAIM_PROTOCOL: 'fenced',
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_MAX_CONCURRENT_JOBS: '1',
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
    WORKER_CLAIM_PROTOCOL: 'fenced',
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_MAX_CONCURRENT_JOBS: '1',
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
    WORKER_CLAIM_PROTOCOL: 'fenced',
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_MAX_CONCURRENT_JOBS: '1',
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
  || ! -f "$package_one/src/report-json-parser-worker.mjs" \
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
if bash "$activator" --revision "$fixture_revision" >/dev/null 2>&1; then
  echo "activator accepted a missing Vercel report-claim handoff" >&2
  exit 1
fi
wrong_revision=1111111111111111111111111111111111111111
if bash "$installer" --revision "$wrong_revision" >/dev/null 2>&1; then
  echo "installer accepted a mismatched revision" >&2
  exit 1
fi
dirty_probe="$repo_root/.wp172-dirty-probe"
touch "$dirty_probe"
fake_bin="$test_tmp/fake-bin"
install -d "$fake_bin"
cat >"$fake_bin/mktemp" <<EOF
#!/usr/bin/env bash
touch "$test_tmp/mktemp-was-called"
exit 91
EOF
chmod +x "$fake_bin/mktemp"
if PATH="$fake_bin:$PATH" bash "$installer" \
  --revision "$(git -C "$repo_root" rev-parse HEAD)" \
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
if [[ -e "$test_tmp/mktemp-was-called" ]]; then
  echo "installer allocated a temporary directory before refusing a dirty checkout" >&2
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
      worker: {
        stopping: false,
        running: 0,
        settlementFailure: mode === "settlement" ? "ownership_lost" : null,
      },
      deployment: {
        revision,
        role: mode === "role" ? "general" : "evo-report-lane",
        claimProtocol: mode === "protocol" ? "legacy" : "fenced",
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
for mode in role claims protocol settlement; do
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
