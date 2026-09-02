#!/usr/bin/env bash

# Shared fail-closed invariants for the Evo report worker deployment commands.
# Callers must install their cleanup trap before acquiring the lock.

report_worker_release_root=/opt/openspell-report-worker
report_worker_service=openspell-report-worker.service
report_worker_legacy_service=wizard-ads-worker.service
report_worker_claim_set='creative.sync,report.request'
report_worker_claim_set+=',report.poll,report.fetch'
report_worker_job_types_key='WORKER_JOB'
report_worker_job_types_key+='_TYPES'
report_worker_claim_protocol_key='WORKER_CLAIM_PROTOCOL'
report_worker_claim_batch_key='WORKER_CLAIM_BATCH_SIZE'
report_worker_concurrency_key='WORKER_MAX_CONCURRENT_JOBS'
report_worker_deployment_lock=/run/lock/openspell-report-worker-deployment.lock
report_worker_lock_held=false
report_worker_lock_pid=
report_worker_lock_write_fd=
report_worker_script_dir="${report_worker_script_dir:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

report_worker_run_privileged() {
  sudo "$@"
}

assert_report_worker_transition_source() {
  local expected_revision="${1:-}"
  local repo_root helper_relative helper_mode
  repo_root="$(git -C "$report_worker_script_dir" rev-parse --show-toplevel 2>/dev/null)" \
    || return 1
  [[ "$report_worker_script_dir" == "$repo_root/docs/deploy" ]] || return 1
  [[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] || return 1
  if [[ -n "$expected_revision" ]] \
    && [[ "$(git -C "$repo_root" rev-parse HEAD)" != "$expected_revision" ]]; then
    return 1
  fi
  helper_relative=docs/deploy/openspell-report-worker-readiness.mjs
  git -C "$repo_root" ls-files --error-unmatch "$helper_relative" >/dev/null 2>&1 \
    || return 1
  helper_mode="$(git -C "$repo_root" ls-files -s -- "$helper_relative")"
  [[ "$helper_mode" == 100755\ * ]]
}

acquire_report_worker_deployment_lock() {
  local lock="${1:-$report_worker_deployment_lock}"
  local ready=

  if report_worker_run_privileged test -L "$lock" \
    || { report_worker_run_privileged test -e "$lock" \
      && ! report_worker_run_privileged test -f "$lock"; }; then
    echo "refusing deployment: serialization lock path is unsafe" >&2
    return 1
  fi
  report_worker_run_privileged touch "$lock"
  report_worker_run_privileged chown root:root "$lock"
  report_worker_run_privileged chmod 0600 "$lock"
  if report_worker_run_privileged test -L "$lock" \
    || [[ "$(report_worker_run_privileged stat -c '%a:%U:%G' "$lock")" != 600:root:root ]]; then
    echo "refusing deployment: serialization lock metadata is unsafe" >&2
    return 1
  fi
  coproc REPORT_WORKER_LOCK_HOLDER {
    report_worker_run_privileged flock --exclusive --nonblock "$lock" \
      sh -c 'printf "locked\n"; IFS= read -r _'
  }
  report_worker_lock_pid=$REPORT_WORKER_LOCK_HOLDER_PID
  report_worker_lock_write_fd=${REPORT_WORKER_LOCK_HOLDER[1]}
  if ! IFS= read -r -t 5 ready <&"${REPORT_WORKER_LOCK_HOLDER[0]}" \
    || [[ "$ready" != locked ]]; then
    wait "$report_worker_lock_pid" 2>/dev/null || true
    report_worker_lock_pid=
    report_worker_lock_write_fd=
    echo "refusing deployment: another report worker deployment operation is running" >&2
    return 1
  fi
  report_worker_deployment_lock="$lock"
  report_worker_lock_held=true
}

release_report_worker_deployment_lock() {
  if [[ "$report_worker_lock_held" == true ]]; then
    { printf '\n' >&"$report_worker_lock_write_fd"; } 2>/dev/null || true
    wait "$report_worker_lock_pid" 2>/dev/null || true
  fi
  report_worker_lock_held=false
  report_worker_lock_pid=
  report_worker_lock_write_fd=
}

verify_report_worker_artifact() {
  local target="$1"
  local expected="$2"
  local require_root="${3:-false}"
  local counts actual_directories actual_files actual_links
  [[ -d "$target" ]] || return 1
  [[ "$(cat "$target/REVISION" 2>/dev/null || true)" == "$expected" ]] || return 1
  [[ "$(cat "$target/public.conf" 2>/dev/null || true)" == \
    "OPENSPELL_WORKER_REVISION=$expected"$'\n'"WORKER_DEPLOYMENT_ROLE=evo-report-lane"$'\n'"$report_worker_job_types_key=$report_worker_claim_set"$'\n'"$report_worker_claim_protocol_key=fenced"$'\n'"$report_worker_claim_batch_key=1"$'\n'"$report_worker_concurrency_key=1" ]] \
    || return 1
  (cd "$target" && sha256sum -c ARTIFACT_SHA256 >/dev/null) || return 1
  counts="$(cat "$target/ARTIFACT_COUNTS" 2>/dev/null || true)"
  actual_directories="$(find "$target" -type d | wc -l)"
  actual_files="$(find "$target" -type f | wc -l)"
  actual_links="$(find "$target" -type l | wc -l)"
  [[ "$counts" == "directories=$actual_directories"$'\n'"files=$actual_files"$'\n'"symlinks=$actual_links" ]] \
    || return 1
  if find "$target" \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
    return 1
  fi
  if [[ "$require_root" == true ]] \
    && find "$target" -xdev \( ! -user root -o ! -group root \) -print -quit | grep -q .; then
    return 1
  fi
  diff -u "$target/ARTIFACT_DIRECTORIES" \
    <(cd "$target" && find . -type d -printf '%P\n' | LC_ALL=C sort) >/dev/null \
    || return 1
  diff -u "$target/ARTIFACT_LINKS" \
    <(cd "$target" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort) >/dev/null \
    || return 1
  while IFS= read -r -d '' link_path; do
    case "$(readlink -f "$link_path" 2>/dev/null || true)" in
      "$target"/*) ;;
      *) return 1 ;;
    esac
  done < <(find "$target" -type l -print0)
}

verify_report_worker_release() {
  local target="$1"
  local revision="$2"
  verify_report_worker_artifact "$target" "$revision" true \
    && report_worker_run_privileged systemd-analyze verify \
      "$target/systemd/openspell-report-worker.service" >/dev/null
}

verify_report_worker_fenced_protocol() {
  local release="$1"
  local revision="$2"
  verify_report_worker_release "$release" "$revision" \
    && [[ "$(sed -n '4p' "$release/public.conf" 2>/dev/null || true)" \
      == "$report_worker_claim_protocol_key=fenced" ]] \
    && [[ "$(sed -n '5p' "$release/public.conf" 2>/dev/null || true)" \
      == "$report_worker_claim_batch_key=1" ]] \
    && [[ "$(sed -n '6p' "$release/public.conf" 2>/dev/null || true)" \
      == "$report_worker_concurrency_key=1" ]]
}

verify_report_worker_credentials() {
  local credential_store=/etc/credstore.encrypted
  local credential_ids=(
    openspell-report-worker-database-url
    openspell-report-worker-ads-application
  )
  local credential_id credential_path credential_metadata
  for credential_id in "${credential_ids[@]}"; do
    credential_path="$credential_store/$credential_id"
    if ! report_worker_run_privileged test -f "$credential_path" \
      || report_worker_run_privileged test -L "$credential_path"; then
      echo "refusing deployment: encrypted runtime credential is unavailable: $credential_id" >&2
      return 1
    fi
    credential_metadata="$(report_worker_run_privileged stat -c '%a:%U:%G' "$credential_path")"
    case "$credential_metadata" in
      400:root:root | 600:root:root) ;;
      *)
        echo "refusing deployment: encrypted runtime credential metadata is unsafe: $credential_id" >&2
        return 1
        ;;
    esac
  done
}

report_worker_database_probe() {
  local expected_transition_revision="$1"
  local mode="$2"
  local database_credential=/etc/credstore.encrypted/openspell-report-worker-database-url
  if ! assert_report_worker_transition_source "$expected_transition_revision"; then
    echo "refusing database probe: transition helper does not match the approved revision" >&2
    return 1
  fi
  report_worker_run_privileged systemd-creds decrypt "$database_credential" - \
    | /usr/local/bin/node "$report_worker_script_dir/../../node_modules/tsx/dist/cli.mjs" \
      "$report_worker_script_dir/openspell-report-worker-readiness.mjs" "$mode"
}

verify_report_worker_database_contract() {
  report_worker_database_probe "$1" --database-contract >/dev/null
}

verify_report_worker_fenced_authority() {
  report_worker_database_probe "$1" --fenced-authority >/dev/null
}

activate_report_worker_fenced_authority() {
  report_worker_database_probe "$1" --activate-fenced-authority
}

assert_report_worker_authority_activated() {
  local result="$1"
  /usr/local/bin/node -e '
    const value = JSON.parse(process.argv[1]);
    if (Object.keys(value).sort().join(",") !== "decision,epoch,unresolved"
      || !["activated", "already_fenced"].includes(value.decision)
      || typeof value.epoch !== "string"
      || !/^[1-9][0-9]*$/u.test(value.epoch)
      || value.unresolved !== 0) process.exit(1);
  ' "$result"
}

capture_report_worker_custody_snapshot() {
  report_worker_database_probe "$1" --custody-snapshot
}

assert_report_worker_custody_drained() {
  local snapshot="$1"
  /usr/local/bin/node -e '
    const value = JSON.parse(process.argv[1]);
    if (Object.keys(value).sort().join(",") !== "fingerprint,schemaVersion,unresolved"
      || value.schemaVersion !== 1
      || value.unresolved !== 0
      || !/^[0-9a-f]{64}$/u.test(value.fingerprint)) process.exit(1);
  ' "$snapshot"
}

report_worker_service_state() {
  local service="$1"
  systemctl show "$service" \
    --property=LoadState --property=ActiveState --property=UnitFileState \
    --no-pager 2>/dev/null
}

assert_report_worker_service_retired() {
  local service="$1"
  local state
  if ! state="$(report_worker_service_state "$service")" \
    || ! printf '%s\n' "$state" \
      | /usr/local/bin/node "$report_worker_script_dir/openspell-report-worker-service-state.mjs"; then
    echo "refusing deployment: $service is not absent or inactive and disabled" >&2
    return 1
  fi
}

assert_legacy_report_worker_retired() {
  assert_report_worker_service_retired "$report_worker_legacy_service"
}

switch_report_worker_link() {
  local target="$1"
  local suffix="$2"
  local temporary="$report_worker_release_root/.current-$suffix"
  report_worker_run_privileged ln -sfn "$target" "$temporary"
  report_worker_run_privileged mv -Tf "$temporary" "$report_worker_release_root/current"
}

install_report_worker_unit() {
  local release="$1"
  local suffix="$2"
  local staged_unit="/etc/systemd/system/.openspell-report-worker.service.$suffix"
  report_worker_run_privileged install -m 0644 -o root -g root \
    "$release/systemd/openspell-report-worker.service" "$staged_unit" \
    && report_worker_run_privileged mv -Tf "$staged_unit" \
      "/etc/systemd/system/$report_worker_service"
}

report_worker_health() {
  local revision="$1"
  local attempts="${2:-1}"
  /usr/local/bin/node \
    "$report_worker_release_root/current/bin/openspell-report-worker-health.mjs" \
    http://127.0.0.1:3000/healthz "$revision" "$attempts"
}

verify_report_worker_live() {
  local revision="$1"
  local release="$report_worker_release_root/releases/$revision"
  [[ "$(report_worker_run_privileged readlink "$report_worker_release_root/current" 2>/dev/null || true)" \
    == "releases/$revision" ]] \
    && verify_report_worker_release "$release" "$revision" \
    && report_worker_run_privileged cmp -s \
      "$release/systemd/openspell-report-worker.service" \
      "/etc/systemd/system/$report_worker_service" \
    && [[ "$(systemctl is-enabled "$report_worker_service" 2>/dev/null || true)" == enabled ]] \
    && [[ "$(systemctl is-active "$report_worker_service" 2>/dev/null || true)" == active ]] \
    && report_worker_health "$revision" 1
}

stop_report_worker_and_prove_inactive() {
  report_worker_run_privileged systemctl stop "$report_worker_service" >/dev/null \
    && [[ "$(systemctl is-active "$report_worker_service" 2>/dev/null || true)" == inactive ]]
}

disable_report_worker_and_prove_disabled() {
  report_worker_run_privileged systemctl disable "$report_worker_service" >/dev/null \
    && [[ "$(systemctl is-enabled "$report_worker_service" 2>/dev/null || true)" == disabled ]]
}

assert_report_worker_exact_absence() {
  local state
  ! report_worker_run_privileged test -e "$report_worker_release_root/current" \
    && ! report_worker_run_privileged test -L "$report_worker_release_root/current" \
    && ! report_worker_run_privileged test -e "/etc/systemd/system/$report_worker_service" \
    && ! report_worker_run_privileged test -L "/etc/systemd/system/$report_worker_service" \
    && state="$(report_worker_service_state "$report_worker_service")" \
    && printf '%s\n' "$state" \
      | /usr/local/bin/node \
        "$report_worker_script_dir/openspell-report-worker-service-state.mjs" --absent
}

restore_report_worker_live() {
  local revision="$1"
  local release="$report_worker_release_root/releases/$revision"
  verify_report_worker_release "$release" "$revision" || return 1
  switch_report_worker_link "releases/$revision" recovery || return 1
  install_report_worker_unit "$release" recovery || return 1
  report_worker_run_privileged systemctl daemon-reload || return 1
  report_worker_run_privileged systemctl enable "$report_worker_service" >/dev/null || return 1
  report_worker_run_privileged systemctl start "$report_worker_service" || return 1
  verify_report_worker_live "$revision"
}

restore_report_worker_absence() {
  leave_report_worker_stopped || return 1
  report_worker_run_privileged rm -f "/etc/systemd/system/$report_worker_service" || return 1
  report_worker_run_privileged rm -f "$report_worker_release_root/current" || return 1
  report_worker_run_privileged systemctl daemon-reload || return 1
  assert_report_worker_exact_absence
}

restore_report_worker_state_if_unchanged() {
  local before="$1"
  local after="$2"
  local prior_revision="${3:-}"
  [[ "$before" == "$after" ]] || return 1
  assert_report_worker_custody_drained "$after" || return 1
  if [[ -n "$prior_revision" ]]; then
    restore_report_worker_live "$prior_revision"
  else
    restore_report_worker_absence
  fi
}

leave_report_worker_stopped() {
  if assert_report_worker_exact_absence >/dev/null 2>&1; then
    return 0
  fi
  stop_report_worker_and_prove_inactive \
    && disable_report_worker_and_prove_disabled \
    && [[ "$(systemctl is-active "$report_worker_service" 2>/dev/null || true)" == inactive ]] \
    && [[ "$(systemctl is-enabled "$report_worker_service" 2>/dev/null || true)" == disabled ]]
}
