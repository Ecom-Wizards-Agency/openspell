#!/usr/bin/env bash

recommendation_worker_release_root=/opt/openspell-recommendation-worker
recommendation_worker_service=openspell-recommendation-worker.service
recommendation_worker_database_credential=/etc/credstore.encrypted/openspell-recommendation-worker-database-url
recommendation_worker_authority_broker=/usr/local/libexec/openspell-recommendation-authority
recommendation_worker_claim_protocol_key=WORKER_CLAIM
recommendation_worker_claim_protocol_key+=_PROTOCOL
recommendation_worker_deployment_role_key=WORKER_DEPLOYMENT
recommendation_worker_deployment_role_key+=_ROLE
recommendation_worker_deployment_lock=/run/lock/openspell-recommendation-worker-deployment.lock
recommendation_worker_lock_held=false
recommendation_worker_script_dir="${recommendation_worker_script_dir:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

recommendation_worker_run_privileged() {
  sudo "$@"
}

assert_recommendation_worker_transition_source() {
  local expected_revision="$1"
  local repo_root
  repo_root="$(git -C "$recommendation_worker_script_dir" rev-parse --show-toplevel 2>/dev/null)" \
    || return 1
  [[ "$recommendation_worker_script_dir" == "$repo_root/docs/deploy" ]] \
    && [[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]] \
    && [[ "$(git -C "$repo_root" rev-parse HEAD)" == "$expected_revision" ]] \
    && git -C "$repo_root" ls-files --error-unmatch \
      docs/deploy/recommendation-worker-evo-systemd-lib.sh >/dev/null 2>&1
}

acquire_recommendation_worker_deployment_lock() {
  local lock="${1:-$recommendation_worker_deployment_lock}"
  local ready=
  if recommendation_worker_run_privileged test -L "$lock" \
    || { recommendation_worker_run_privileged test -e "$lock" \
      && ! recommendation_worker_run_privileged test -f "$lock"; }; then
    echo 'refusing deployment: recommendation worker lock path is unsafe' >&2
    return 1
  fi
  recommendation_worker_run_privileged touch "$lock"
  recommendation_worker_run_privileged chown root:root "$lock"
  recommendation_worker_run_privileged chmod 0600 "$lock"
  coproc RECOMMENDATION_WORKER_LOCK_HOLDER {
    recommendation_worker_run_privileged flock --exclusive --nonblock "$lock" \
      sh -c 'printf "locked\n"; IFS= read -r _'
  }
  recommendation_worker_lock_pid=$RECOMMENDATION_WORKER_LOCK_HOLDER_PID
  recommendation_worker_lock_write_fd=${RECOMMENDATION_WORKER_LOCK_HOLDER[1]}
  if ! IFS= read -r -t 5 ready <&"${RECOMMENDATION_WORKER_LOCK_HOLDER[0]}" \
    || [[ "$ready" != locked ]]; then
    wait "$recommendation_worker_lock_pid" 2>/dev/null || true
    echo 'refusing deployment: another recommendation worker transition is running' >&2
    return 1
  fi
  recommendation_worker_deployment_lock="$lock"
  recommendation_worker_lock_held=true
}

release_recommendation_worker_deployment_lock() {
  if [[ "$recommendation_worker_lock_held" == true ]]; then
    { printf '\n' >&"$recommendation_worker_lock_write_fd"; } 2>/dev/null || true
    wait "$recommendation_worker_lock_pid" 2>/dev/null || true
  fi
  recommendation_worker_lock_held=false
}

verify_recommendation_worker_artifact() {
  local target="$1"
  local revision="$2"
  local require_root="${3:-false}"
  local counts directories files links
  [[ -d "$target" ]] || return 1
  [[ "$(cat "$target/REVISION" 2>/dev/null || true)" == "$revision" ]] || return 1
  [[ "$(cat "$target/public-standby.conf" 2>/dev/null || true)" == \
    "OPENSPELL_WORKER_REVISION=$revision"$'\n'"PORT=3002"$'\n'"WORKER_CLAIM_ARMED=0"$'\n'"WORKER_CLAIM_BATCH_SIZE=1"$'\n'"$recommendation_worker_claim_protocol_key=recommendation-fenced-v1"$'\n'"$recommendation_worker_deployment_role_key=evo-recommendation-lane"$'\n'"WORKER_ID=evo-recommendation-worker"$'\n'"WORKER_JOB_TYPES=recommendations.run"$'\n'"WORKER_MAX_CONCURRENT_JOBS=1"$'\n'"WORKER_POLL_INTERVAL_MS=1000"$'\n'"WORKER_SHUTDOWN_DRAIN_MS=25000" ]] || return 1
  [[ "$(sed 's/WORKER_CLAIM_ARMED=0/WORKER_CLAIM_ARMED=1/' \
    "$target/public-standby.conf")" == "$(cat "$target/public-armed.conf")" ]] || return 1
  (cd "$target" && sha256sum -c ARTIFACT_SHA256 >/dev/null) || return 1
  counts="$(cat "$target/ARTIFACT_COUNTS" 2>/dev/null || true)"
  directories="$(find "$target" -type d | wc -l)"
  files="$(find "$target" -type f | wc -l)"
  links="$(find "$target" -type l | wc -l)"
  [[ "$counts" == "directories=$directories"$'\n'"files=$files"$'\n'"symlinks=$links" ]] \
    || return 1
  ! find "$target" \( -type f -o -type d \) -perm /022 -print -quit | grep -q . \
    || return 1
  [[ "$require_root" != true ]] \
    || ! find "$target" -xdev \( ! -user root -o ! -group root \) -print -quit | grep -q .
}

verify_recommendation_worker_release() {
  local target="$1"
  local revision="$2"
  verify_recommendation_worker_artifact "$target" "$revision" true \
    && recommendation_worker_run_privileged systemd-analyze verify \
      "$target/systemd/openspell-recommendation-worker-standby.service" \
      "$target/systemd/openspell-recommendation-worker-armed.service" >/dev/null
}

verify_recommendation_worker_credential() {
  local metadata
  if ! recommendation_worker_run_privileged test -f "$recommendation_worker_database_credential" \
    || recommendation_worker_run_privileged test -L "$recommendation_worker_database_credential"; then
    echo 'refusing deployment: narrow recommendation database credential is unavailable' >&2
    return 1
  fi
  metadata="$(recommendation_worker_run_privileged stat -c '%a:%U:%G' \
    "$recommendation_worker_database_credential")"
  [[ "$metadata" == 400:root:root || "$metadata" == 600:root:root ]] || {
    echo 'refusing deployment: recommendation database credential metadata is unsafe' >&2
    return 1
  }
}

verify_recommendation_authority_broker() {
  local metadata
  [[ "$recommendation_worker_authority_broker" == /usr/local/libexec/openspell-recommendation-authority ]] \
    || return 1
  recommendation_worker_run_privileged test -f "$recommendation_worker_authority_broker" \
    && ! recommendation_worker_run_privileged test -L "$recommendation_worker_authority_broker" \
    && metadata="$(recommendation_worker_run_privileged stat -c '%a:%U:%G' \
      "$recommendation_worker_authority_broker")" \
    && [[ "$metadata" == 700:root:root || "$metadata" == 755:root:root ]]
}

recommendation_worker_authority_helper() {
  local release="$1"
  shift
  /usr/local/bin/node "$release/bin/openspell-recommendation-worker-authority.mjs" "$@"
}

read_recommendation_authority() {
  local release="$1"
  local revision="$2"
  recommendation_worker_run_privileged systemd-creds decrypt \
    "$recommendation_worker_database_credential" - \
    | recommendation_worker_authority_helper "$release" --read "$revision"
}

read_recommendation_cutover_evidence() {
  local release="$1"
  local revision="$2"
  recommendation_worker_run_privileged systemd-creds decrypt \
    "$recommendation_worker_database_credential" - \
    | recommendation_worker_authority_helper "$release" --evidence "$revision"
}

validate_recommendation_cutover_evidence() {
  local release="$1"
  local phase="$2"
  local revision="$3"
  recommendation_worker_authority_helper "$release" \
    --validate-evidence "$phase" "$revision"
}

expected_recommendation_authority() {
  local release="$1"
  local operation="$2"
  local old_tuple="$3"
  local revision="$4"
  recommendation_worker_authority_helper "$release" \
    --expected "$operation" "$old_tuple" "$revision"
}

invoke_recommendation_authority_broker_once() {
  local release="$1"
  local operation="$2"
  local old_tuple="$3"
  local revision="$4"
  local epoch old_revision output broker_status
  epoch="$(/usr/local/bin/node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).epoch))' \
    "$old_tuple")" || return 1
  old_revision="$(/usr/local/bin/node -e \
    'process.stdout.write(JSON.parse(process.argv[1]).authorizedRevision ?? "-")' \
    "$old_tuple")" || return 1
  broker_status=0
  output="$(recommendation_worker_run_privileged "$recommendation_worker_authority_broker" \
    "$operation" "$epoch" "$old_revision" "$revision" 2>/dev/null)" || broker_status=$?
  [[ ${#output} -le 4096 ]] || return 78
  if [[ -n "$output" ]]; then
    printf '%s' "$output" \
      | recommendation_worker_authority_helper "$release" \
        --validate-broker "$operation" || return 78
  elif ((broker_status == 0)); then
    return 78
  fi
  ((broker_status == 0)) || return 2
}

reconcile_recommendation_transition() {
  local release="$1"
  local revision="$2"
  local old_tuple="$3"
  local new_tuple="$4"
  local actual=
  local attempt
  for attempt in 1 2 3; do
    : "$attempt"
    actual="$(read_recommendation_authority "$release" "$revision" 2>/dev/null)" && break
    sleep 0.25
  done
  [[ -n "$actual" ]] || return 78
  printf '%s' "$actual" \
    | recommendation_worker_authority_helper "$release" \
      --classify "$old_tuple" "$new_tuple"
}

transition_recommendation_authority() {
  local release="$1"
  local revision="$2"
  local operation="$3"
  local old_tuple="$4"
  local new_tuple
  new_tuple="$(expected_recommendation_authority \
    "$release" "$operation" "$old_tuple" "$revision")" || return 78
  # Exactly one broker invocation. Its transport result never authorizes a path;
  # the read-only narrow-principal tuple below is the sole outcome authority.
  invoke_recommendation_authority_broker_once \
    "$release" "$operation" "$old_tuple" "$revision" >/dev/null \
    || true
  reconcile_recommendation_transition \
    "$release" "$revision" "$old_tuple" "$new_tuple"
}

normalize_recommendation_worker_artifact_modes() {
  local release="$1"
  [[ -d "$release" ]] || return 1
  find "$release" -type d -exec chmod 0755 {} +
  find "$release" -type f -exec chmod 0644 {} +
}

switch_recommendation_worker_link() {
  local target="$1"
  local suffix="$2"
  local temporary="$recommendation_worker_release_root/.current-$suffix"
  recommendation_worker_run_privileged ln -sfn "$target" "$temporary" \
    && recommendation_worker_run_privileged mv -Tf \
      "$temporary" "$recommendation_worker_release_root/current"
}

install_recommendation_worker_unit() {
  local release="$1"
  local mode="$2"
  local suffix="$3"
  local staged="/etc/systemd/system/.openspell-recommendation-worker.service.$suffix"
  recommendation_worker_run_privileged install -m 0644 -o root -g root \
    "$release/systemd/openspell-recommendation-worker-$mode.service" "$staged" \
    && recommendation_worker_run_privileged mv -Tf \
      "$staged" "/etc/systemd/system/$recommendation_worker_service"
}

recommendation_worker_health() {
  local revision="$1"
  local armed="$2"
  local attempts="${3:-1}"
  /usr/local/bin/node \
    "$recommendation_worker_release_root/current/bin/openspell-recommendation-worker-health.mjs" \
    http://127.0.0.1:3002/healthz "$revision" "$armed" "$attempts"
}

verify_recommendation_worker_live() {
  local revision="$1"
  local mode="$2"
  local armed=0
  [[ "$mode" == armed ]] && armed=1
  local release="$recommendation_worker_release_root/releases/$revision"
  [[ "$(recommendation_worker_run_privileged readlink \
    "$recommendation_worker_release_root/current" 2>/dev/null || true)" == "releases/$revision" ]] \
    && verify_recommendation_worker_release "$release" "$revision" \
    && recommendation_worker_run_privileged cmp -s \
      "$release/systemd/openspell-recommendation-worker-$mode.service" \
      "/etc/systemd/system/$recommendation_worker_service" \
    && [[ "$(systemctl is-enabled "$recommendation_worker_service" 2>/dev/null || true)" == enabled ]] \
    && [[ "$(systemctl is-active "$recommendation_worker_service" 2>/dev/null || true)" == active ]] \
    && recommendation_worker_health "$revision" "$armed" 1
}

stop_recommendation_worker() {
  recommendation_worker_run_privileged systemctl stop "$recommendation_worker_service" >/dev/null \
    && [[ "$(systemctl is-active "$recommendation_worker_service" 2>/dev/null || true)" == inactive ]]
}

leave_recommendation_worker_stopped() {
  recommendation_worker_run_privileged systemctl stop "$recommendation_worker_service" >/dev/null \
    && recommendation_worker_run_privileged systemctl disable \
      "$recommendation_worker_service" >/dev/null \
    && [[ "$(systemctl is-active "$recommendation_worker_service" 2>/dev/null || true)" \
      == inactive ]] \
    && [[ "$(systemctl is-enabled "$recommendation_worker_service" 2>/dev/null || true)" \
      == disabled ]]
}

assert_recommendation_worker_exact_absence() {
  local load active enabled
  load="$(systemctl show "$recommendation_worker_service" -p LoadState --value 2>/dev/null || true)"
  active="$(systemctl show "$recommendation_worker_service" -p ActiveState --value 2>/dev/null || true)"
  enabled="$(systemctl is-enabled "$recommendation_worker_service" 2>/dev/null || true)"
  ! recommendation_worker_run_privileged test -e "$recommendation_worker_release_root/current" \
    && ! recommendation_worker_run_privileged test -L "$recommendation_worker_release_root/current" \
    && ! recommendation_worker_run_privileged test -e \
      "/etc/systemd/system/$recommendation_worker_service" \
    && [[ "$load" == not-found && "$active" == inactive && "$enabled" == not-found ]]
}

assert_recommendation_worker_recoverable_inactive() {
  local release="$1"
  [[ "$(systemctl is-active "$recommendation_worker_service" 2>/dev/null || true)" \
    == inactive ]] \
    && [[ "$(systemctl is-enabled "$recommendation_worker_service" 2>/dev/null || true)" \
      == disabled ]] \
    && { recommendation_worker_run_privileged cmp -s \
      "$release/systemd/openspell-recommendation-worker-standby.service" \
      "/etc/systemd/system/$recommendation_worker_service" \
      || recommendation_worker_run_privileged cmp -s \
        "$release/systemd/openspell-recommendation-worker-armed.service" \
        "/etc/systemd/system/$recommendation_worker_service"; }
}

start_recommendation_worker_release() {
  local release="$1"
  local revision="$2"
  local mode="$3"
  switch_recommendation_worker_link "releases/$revision" "$mode-$revision" \
    && install_recommendation_worker_unit "$release" "$mode" "$mode-$revision" \
    && recommendation_worker_run_privileged systemctl daemon-reload \
    && recommendation_worker_run_privileged systemctl enable \
      "$recommendation_worker_service" >/dev/null \
    && recommendation_worker_run_privileged systemctl start "$recommendation_worker_service" \
    && verify_recommendation_worker_live "$revision" "$mode"
}

capture_preserved_worker_state() {
  systemctl show wizard-ads-worker.service openspell-report-worker.service \
    --property=Names --property=LoadState --property=ActiveState --property=UnitFileState \
    --no-pager 2>/dev/null
}

assert_preserved_worker_state() {
  local before="$1"
  [[ "$(capture_preserved_worker_state)" == "$before" ]]
}
