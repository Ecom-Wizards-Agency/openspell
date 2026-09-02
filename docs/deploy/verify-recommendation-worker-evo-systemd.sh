#!/usr/bin/env bash
set -euo pipefail

expected_revision="${1:-}"
mode="${2:---armed}"
[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] \
  && [[ "$mode" == --armed || "$mode" == --standby ]] || {
  echo "usage: $0 <full-git-object-id> [--armed|--standby]" >&2; exit 2;
}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
recommendation_worker_script_dir="$script_dir"
cleanup() { release_recommendation_worker_deployment_lock; }
trap cleanup EXIT

assert_recommendation_worker_transition_source "$expected_revision" || {
  echo 'recommendation worker verification source does not match live revision' >&2; exit 1;
}
acquire_recommendation_worker_deployment_lock
verify_recommendation_worker_credential
release="$recommendation_worker_release_root/releases/$expected_revision"
live_mode=armed
[[ "$mode" == --standby ]] && live_mode=standby
verify_recommendation_worker_live "$expected_revision" "$live_mode" || {
  echo 'recommendation worker deployment is incomplete or mismatched' >&2; exit 1;
}
authority="$(read_recommendation_authority "$release" "$expected_revision")" || {
  echo 'recommendation worker authority readback failed' >&2; exit 1;
}
if [[ "$live_mode" == armed ]]; then
  /usr/local/bin/node -e '
    const value = JSON.parse(process.argv[1]);
    if (value.protocol !== "fenced" || value.authorizedRevision !== process.argv[2]
      || !["blocked", "scoped"].includes(value.admission)) process.exit(1);
  ' "$authority" "$expected_revision" || {
    echo 'recommendation worker armed authority tuple is invalid' >&2; exit 1;
  }
fi
echo "OpenSpell recommendation worker verified at revision $expected_revision ($live_mode)"
