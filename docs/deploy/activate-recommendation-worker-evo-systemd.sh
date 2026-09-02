#!/usr/bin/env bash
set -euo pipefail

expected_revision=
while (($# > 0)); do
  case "$1" in
    --revision) expected_revision="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --revision <full-git-object-id>" >&2; exit 2 ;;
  esac
done
[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'refusing activation: revision is invalid' >&2; exit 2;
}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
recommendation_worker_script_dir="$script_dir"
cleanup() { release_recommendation_worker_deployment_lock; }
trap cleanup EXIT

for command in cmp flock git readlink sudo systemctl systemd-analyze systemd-creds; do
  command -v "$command" >/dev/null || {
    echo "refusing activation: required command is unavailable: $command" >&2; exit 1;
  }
done
assert_recommendation_worker_transition_source "$expected_revision" || {
  echo 'refusing activation: transition source is not the approved clean revision' >&2; exit 1;
}
acquire_recommendation_worker_deployment_lock
verify_recommendation_worker_credential
verify_recommendation_authority_broker || {
  echo 'refusing activation: root-owned authority broker contract is unavailable' >&2; exit 1;
}
preserved_before="$(capture_preserved_worker_state)" || {
  echo 'refusing activation: integration/report worker state is unavailable' >&2; exit 1;
}
release="$recommendation_worker_release_root/releases/$expected_revision"
verify_recommendation_worker_release "$release" "$expected_revision" || {
  echo 'refusing activation: staged release is invalid' >&2; exit 1;
}

current_target="$(recommendation_worker_run_privileged readlink \
  "$recommendation_worker_release_root/current" 2>/dev/null || true)"
if [[ -n "$current_target" ]]; then
  if [[ "$current_target" == "releases/$expected_revision" ]] \
    && verify_recommendation_worker_live "$expected_revision" armed; then
    authority="$(read_recommendation_authority "$release" "$expected_revision")"
    /usr/local/bin/node -e '
      const value = JSON.parse(process.argv[1]);
      if (value.protocol !== "fenced" || value.authorizedRevision !== process.argv[2]
        || !["blocked", "scoped"].includes(value.admission)) process.exit(1);
    ' "$authority" "$expected_revision" || {
      echo 'refusing activation: live revision authority is incompatible' >&2; exit 1;
    }
    assert_preserved_worker_state "$preserved_before" || exit 1
    echo "OpenSpell recommendation worker $expected_revision is already armed"
    exit 0
  fi
  if [[ "$current_target" != "releases/$expected_revision" ]] \
    || ! assert_recommendation_worker_recoverable_inactive "$release"; then
    echo 'refusing activation: use revision rebind for a different or live deployment' >&2
    exit 1
  fi
else
  assert_recommendation_worker_exact_absence || {
    echo 'refusing activation: first activation did not start from exact absence' >&2; exit 1;
  }
fi

authority="$(read_recommendation_authority "$release" "$expected_revision")" || {
  echo 'refusing activation: narrow-principal authority readback failed' >&2; exit 1;
}
protocol="$(/usr/local/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).protocol)' \
  "$authority")"
authorized="$(/usr/local/bin/node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).authorizedRevision ?? "-")' "$authority")"
if [[ "$protocol" == fenced && "$authorized" != "$expected_revision" ]]; then
  echo 'refusing activation: fenced authority belongs to another revision' >&2
  exit 1
fi
admission="$(/usr/local/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).admission)' \
  "$authority")"
if [[ "$admission" != blocked ]]; then
  block_result="$(transition_recommendation_authority \
    "$release" "$expected_revision" block "$authority")" || block_status=$?
  block_status="${block_status:-0}"
  if [[ "$block_status" != 0 || "$block_result" != committed ]]; then
    echo 'refusing activation: admission block CAS was not proven committed' >&2
    exit 1
  fi
  authority="$(read_recommendation_authority "$release" "$expected_revision")"
fi

if ! start_recommendation_worker_release "$release" "$expected_revision" standby; then
  leave_recommendation_worker_stopped || true
  echo 'recommendation activation failed: candidate standby did not become healthy' >&2
  exit 1
fi

if [[ "$protocol" == legacy ]]; then
  activation_result="$(transition_recommendation_authority \
    "$release" "$expected_revision" activate "$authority")" || activation_status=$?
  activation_status="${activation_status:-0}"
  if [[ "$activation_status" != 0 || "$activation_result" != committed ]]; then
    leave_recommendation_worker_stopped || true
    echo 'recommendation activation failed: fenced CAS outcome is not exactly committed' >&2
    exit 1
  fi
elif [[ "$protocol" != fenced || "$authorized" != "$expected_revision" ]]; then
  leave_recommendation_worker_stopped || true
  echo 'recommendation activation failed: authority belongs to another revision' >&2
  exit 1
fi

stop_recommendation_worker || {
  echo 'recommendation activation failed: standby could not be stopped before arming' >&2; exit 1;
}
if ! start_recommendation_worker_release "$release" "$expected_revision" armed; then
  leave_recommendation_worker_stopped || true
  echo 'recommendation activation failed after fencing; admission remains blocked and no legacy restoration was attempted' >&2
  exit 1
fi
assert_preserved_worker_state "$preserved_before" || {
  leave_recommendation_worker_stopped || true
  echo 'recommendation activation failed: integration/report worker state changed' >&2
  exit 1
}
echo "activated OpenSpell recommendation worker release $expected_revision"
