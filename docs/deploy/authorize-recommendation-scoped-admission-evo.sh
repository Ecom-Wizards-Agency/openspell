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
  echo 'refusing scoped admission: revision is invalid' >&2; exit 2;
}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
recommendation_worker_script_dir="$script_dir"
cleanup() { release_recommendation_worker_deployment_lock; }
trap cleanup EXIT

for command in flock git sudo systemctl systemd-creds; do
  command -v "$command" >/dev/null || {
    echo "refusing scoped admission: required command is unavailable: $command" >&2; exit 1;
  }
done
assert_recommendation_worker_transition_source "$expected_revision" || {
  echo 'refusing scoped admission: transition source is not the approved clean revision' >&2
  exit 1
}
acquire_recommendation_worker_deployment_lock
verify_recommendation_worker_credential
verify_recommendation_authority_broker || {
  echo 'refusing scoped admission: root-owned authority broker contract is unavailable' >&2
  exit 1
}
preserved_before="$(capture_preserved_worker_state)" || {
  echo 'refusing scoped admission: integration/report worker state is unavailable' >&2
  exit 1
}
release="$recommendation_worker_release_root/releases/$expected_revision"
verify_recommendation_worker_live "$expected_revision" armed || {
  echo 'refusing scoped admission: exact recommendation worker is not live and armed' >&2
  exit 1
}

authority="$(read_recommendation_authority "$release" "$expected_revision")" || {
  echo 'refusing scoped admission: authority readback failed' >&2; exit 1;
}
admission="$(/usr/local/bin/node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).admission)' "$authority")"
if [[ "$admission" == scoped ]]; then
  read_recommendation_cutover_evidence "$release" "$expected_revision" \
    | validate_recommendation_cutover_evidence "$release" post "$expected_revision" || {
      echo 'refusing scoped admission: existing scoped evidence does not close' >&2; exit 1;
    }
  assert_preserved_worker_state "$preserved_before" || exit 1
  echo "OpenSpell recommendation scoped admission is already authorized at $expected_revision"
  exit 0
fi

read_recommendation_cutover_evidence "$release" "$expected_revision" \
  | validate_recommendation_cutover_evidence "$release" pre "$expected_revision" || {
    echo 'refusing scoped admission: preflight evidence does not close' >&2; exit 1;
  }
authorization_result="$(transition_recommendation_authority \
  "$release" "$expected_revision" authorize "$authority")" || authorization_status=$?
authorization_status="${authorization_status:-0}"
if [[ "$authorization_status" != 0 || "$authorization_result" != committed ]]; then
  echo 'scoped admission outcome is not exactly committed; attended reconciliation is required' >&2
  exit 1
fi
read_recommendation_cutover_evidence "$release" "$expected_revision" \
  | validate_recommendation_cutover_evidence "$release" post "$expected_revision" || {
    echo 'scoped admission committed but postflight evidence does not close' >&2; exit 1;
  }
verify_recommendation_worker_live "$expected_revision" armed || {
  echo 'scoped admission committed but the exact worker is not healthy' >&2; exit 1;
}
assert_preserved_worker_state "$preserved_before" || {
  echo 'scoped admission committed but integration/report worker state changed' >&2; exit 1;
}
echo "authorized OpenSpell recommendation scoped admission at $expected_revision"
