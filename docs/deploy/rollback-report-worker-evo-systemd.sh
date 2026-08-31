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

acquire_report_worker_deployment_lock
verify_report_worker_credentials
assert_legacy_report_worker_retired
if ! verify_report_worker_live "$from_revision"; then
  echo "refusing rollback: current live deployment is incomplete or mismatched" >&2
  exit 1
fi

destination="$report_worker_release_root/releases/$to_revision"
if ! verify_report_worker_release "$destination" "$to_revision"; then
  echo "refusing rollback: retained destination provenance or unit is invalid" >&2
  exit 1
fi

rollback_ok=false
if switch_report_worker_link "releases/$to_revision" rollback \
  && install_report_worker_unit "$destination" "$to_revision" \
  && report_worker_run_privileged systemctl daemon-reload \
  && report_worker_run_privileged systemctl enable "$report_worker_service" >/dev/null \
  && report_worker_run_privileged systemctl restart "$report_worker_service" \
  && verify_report_worker_live "$to_revision"; then
  rollback_ok=true
fi

if [[ "$rollback_ok" != true ]]; then
  if restore_report_worker_live "$from_revision"; then
    echo "OpenSpell report worker rollback failed; the original deployment was fully restored" >&2
  else
    leave_report_worker_stopped
    echo "OpenSpell report worker rollback failed; service remains stopped for attended recovery" >&2
  fi
  exit 1
fi

echo "rolled OpenSpell report worker back from $from_revision to $to_revision"
