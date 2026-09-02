#!/usr/bin/env bash
set -euo pipefail

from_revision="${1:-}"
to_revision="${2:-}"
for revision in "$from_revision" "$to_revision"; do
  if [[ ! "$revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
    echo "usage: $0 <current-full-git-object-id> <retained-full-git-object-id>" >&2
    exit 2
  fi
done
if [[ "$from_revision" == "$to_revision" ]]; then
  echo "refusing rollback: current and retained revisions are identical" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
source "$script_dir/report-worker-evo-systemd-lib.sh"
report_worker_script_dir="$script_dir"
cleanup() {
  release_report_worker_deployment_lock
}
trap cleanup EXIT

if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "refusing rollback: system Node 22 or newer is unavailable" >&2
  exit 1
fi
command -v systemd-creds >/dev/null || {
  echo "refusing rollback: required command is unavailable: systemd-creds" >&2
  exit 1
}
command -v git >/dev/null || {
  echo "refusing rollback: required command is unavailable: git" >&2
  exit 1
}
if ! assert_report_worker_transition_source "$from_revision"; then
  echo "refusing rollback: transition helper does not match the current live revision" >&2
  exit 1
fi

acquire_report_worker_deployment_lock
verify_report_worker_credentials
assert_legacy_report_worker_retired
if ! verify_report_worker_live "$from_revision"; then
  echo "refusing rollback: current live deployment is incomplete or mismatched" >&2
  exit 1
fi

destination="$report_worker_release_root/releases/$to_revision"
if ! verify_report_worker_fenced_protocol "$destination" "$to_revision"; then
  echo "refusing rollback: retained destination does not advertise the exact fenced protocol" >&2
  exit 1
fi
if ! verify_report_worker_fenced_protocol \
  "$report_worker_release_root/releases/$from_revision" "$from_revision"; then
  echo "refusing rollback: current release does not advertise the fenced protocol" >&2
  exit 1
fi
if ! verify_report_worker_database_contract "$from_revision"; then
  echo "refusing rollback: hosted database does not expose the exact fenced contract" >&2
  exit 1
fi
if ! verify_report_worker_fenced_authority "$from_revision"; then
  echo "refusing rollback: database report-lane authority is not fenced" >&2
  exit 1
fi

if ! stop_report_worker_and_prove_inactive; then
  echo "refusing rollback: current report worker did not become inactive" >&2
  exit 1
fi
if ! custody_before="$(capture_report_worker_custody_snapshot "$from_revision")" \
  || ! assert_report_worker_custody_drained "$custody_before"; then
  if leave_report_worker_stopped; then
    echo "refusing rollback: report-lane custody is unresolved; the service is inactive and disabled" >&2
  else
    echo "refusing rollback: report-lane custody is unresolved and service inactivity could not be proved" >&2
  fi
  exit 1
fi

rollback_ok=false
if switch_report_worker_link "releases/$to_revision" rollback \
  && install_report_worker_unit "$destination" "$to_revision" \
  && report_worker_run_privileged systemctl daemon-reload \
  && report_worker_run_privileged systemctl enable "$report_worker_service" >/dev/null \
  && report_worker_run_privileged systemctl start "$report_worker_service" \
  && verify_report_worker_live "$to_revision"; then
  rollback_ok=true
fi

if [[ "$rollback_ok" != true ]]; then
  if ! leave_report_worker_stopped; then
    echo "OpenSpell report worker rollback failed and destination inactivity could not be proved; no automatic restoration was attempted" >&2
    exit 1
  fi
  custody_after=
  if custody_after="$(capture_report_worker_custody_snapshot "$from_revision")" \
    && restore_report_worker_state_if_unchanged \
      "$custody_before" "$custody_after" "$from_revision"; then
    echo "OpenSpell report worker rollback failed before a claim; the original deployment was fully restored" >&2
  else
    if leave_report_worker_stopped; then
      echo "OpenSpell report worker rollback failed with ambiguous custody; the service is inactive and disabled for attended recovery" >&2
    else
      echo "OpenSpell report worker rollback recovery failed and service inactivity could not be proved" >&2
    fi
  fi
  exit 1
fi

echo "rolled OpenSpell report worker back from $from_revision to $to_revision"
