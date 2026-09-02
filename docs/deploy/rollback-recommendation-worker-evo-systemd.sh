#!/usr/bin/env bash
set -euo pipefail

from_revision="${1:-}"
to_revision="${2:-}"
for revision in "$from_revision" "$to_revision"; do
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || {
    echo "usage: $0 <current-full-git-object-id> <retained-full-git-object-id>" >&2; exit 2;
  }
done
[[ "$from_revision" != "$to_revision" ]] || {
  echo 'refusing rebind: revisions are identical' >&2; exit 2;
}
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/recommendation-worker-evo-systemd-lib.sh
source "$script_dir/recommendation-worker-evo-systemd-lib.sh"
recommendation_worker_script_dir="$script_dir"
cleanup() { release_recommendation_worker_deployment_lock; }
trap cleanup EXIT

assert_recommendation_worker_transition_source "$from_revision" || {
  echo 'refusing rebind: helper does not match the live revision' >&2; exit 1;
}
acquire_recommendation_worker_deployment_lock
verify_recommendation_worker_credential
verify_recommendation_authority_broker || {
  echo 'refusing rebind: root-owned authority broker contract is unavailable' >&2; exit 1;
}
preserved_before="$(capture_preserved_worker_state)" || {
  echo 'refusing rebind: integration/report worker state is unavailable' >&2; exit 1;
}
source_release="$recommendation_worker_release_root/releases/$from_revision"
destination="$recommendation_worker_release_root/releases/$to_revision"
verify_recommendation_worker_live "$from_revision" armed || {
  echo 'refusing rebind: source release is not live and armed' >&2; exit 1;
}
verify_recommendation_worker_release "$destination" "$to_revision" || {
  echo 'refusing rebind: destination release is not retained and compatible' >&2; exit 1;
}

authority="$(read_recommendation_authority "$source_release" "$from_revision")" || {
  echo 'refusing rebind: authority readback failed' >&2; exit 1;
}
protocol="$(/usr/local/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).protocol)' \
  "$authority")"
authorized="$(/usr/local/bin/node -e \
  'process.stdout.write(JSON.parse(process.argv[1]).authorizedRevision ?? "-")' "$authority")"
[[ "$protocol" == fenced && "$authorized" == "$from_revision" ]] || {
  echo 'refusing rebind: database authority does not match the source revision' >&2; exit 1;
}
admission="$(/usr/local/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).admission)' \
  "$authority")"
if [[ "$admission" != blocked ]]; then
  block_result="$(transition_recommendation_authority \
    "$source_release" "$from_revision" block "$authority")" || block_status=$?
  block_status="${block_status:-0}"
  if [[ "$block_status" != 0 || "$block_result" != committed ]]; then
    echo 'refusing rebind: admission block CAS was not proven committed' >&2
    exit 1
  fi
  authority="$(read_recommendation_authority "$source_release" "$from_revision")"
fi

stop_recommendation_worker || {
  echo 'refusing rebind: source worker did not become inactive' >&2; exit 1;
}
if ! start_recommendation_worker_release "$destination" "$to_revision" standby; then
  leave_recommendation_worker_stopped || true
  authority_after="$(read_recommendation_authority \
    "$source_release" "$from_revision" 2>/dev/null || true)"
  if [[ "$authority_after" == "$authority" ]] \
    && start_recommendation_worker_release "$source_release" "$from_revision" armed; then
    echo 'recommendation rebind failed before CAS; exact old authority was re-proved and source restored' >&2
  else
    leave_recommendation_worker_stopped || true
    echo 'recommendation rebind failed before CAS and exact old authority/source restoration was not proved' >&2
  fi
  exit 1
fi

rebind_result="$(transition_recommendation_authority \
  "$destination" "$to_revision" rebind "$authority")" || rebind_status=$?
rebind_status="${rebind_status:-0}"
if [[ "$rebind_status" == 0 && "$rebind_result" == committed ]]; then
  stop_recommendation_worker || {
    echo 'recommendation rebind failed: standby could not stop before arming' >&2; exit 1;
  }
  if ! start_recommendation_worker_release "$destination" "$to_revision" armed; then
    leave_recommendation_worker_stopped || true
    echo 'recommendation rebind committed but destination could not arm; both revisions remain stopped' >&2
    exit 1
  fi
elif [[ "$rebind_status" == 0 && "$rebind_result" == not_committed ]]; then
  leave_recommendation_worker_stopped || true
  if start_recommendation_worker_release "$source_release" "$from_revision" armed; then
    echo 'recommendation rebind did not commit; original revision was restored' >&2
  else
    leave_recommendation_worker_stopped || true
    echo 'recommendation rebind did not commit and original revision could not be restored' >&2
  fi
  exit 1
else
  leave_recommendation_worker_stopped || true
  echo 'recommendation rebind outcome is ambiguous; both revisions remain stopped for attended reconciliation' >&2
  exit 1
fi
assert_preserved_worker_state "$preserved_before" || {
  leave_recommendation_worker_stopped || true
  echo 'recommendation rebind failed: integration/report worker state changed' >&2
  exit 1
}
echo "rebound OpenSpell recommendation worker from $from_revision to $to_revision"
