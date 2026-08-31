#!/usr/bin/env bash
set -euo pipefail

expected_revision=
handoff_confirmed=false
while (($# > 0)); do
  case "$1" in
    --revision)
      expected_revision="${2:-}"
      shift 2
      ;;
    --vercel-report-claims-relinquished)
      handoff_confirmed=true
      shift
      ;;
    *)
      echo "usage: $0 --revision <full-git-object-id> --vercel-report-claims-relinquished" >&2
      exit 2
      ;;
  esac
done
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "refusing activation: --revision must be a full lowercase Git object id" >&2
  exit 2
fi
if [[ "$handoff_confirmed" != true ]]; then
  echo "refusing activation: Vercel report-claim relinquishment was not confirmed" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=docs/deploy/report-worker-evo-systemd-lib.sh
source "$script_dir/report-worker-evo-systemd-lib.sh"
report_worker_script_dir="$script_dir"
cleanup() {
  release_report_worker_deployment_lock
}
trap cleanup EXIT

for command in cmp flock readlink sudo systemctl systemd-analyze; do
  command -v "$command" >/dev/null || {
    echo "refusing activation: required command is unavailable: $command" >&2
    exit 1
  }
done
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "refusing activation: system Node 22 or newer is unavailable" >&2
  exit 1
fi

acquire_report_worker_deployment_lock
verify_report_worker_credentials
assert_legacy_report_worker_retired

release="$report_worker_release_root/releases/$expected_revision"
if ! verify_report_worker_release "$release" "$expected_revision"; then
  echo "refusing activation: staged release provenance or unit is invalid" >&2
  exit 1
fi

current_link="$report_worker_release_root/current"
prior_target="$(report_worker_run_privileged readlink "$current_link" 2>/dev/null || true)"
prior_revision=
if [[ -n "$prior_target" ]]; then
  if [[ ! "$prior_target" =~ ^releases/([0-9a-f]{40}([0-9a-f]{24})?)$ ]]; then
    echo "refusing activation: current release link has invalid provenance" >&2
    exit 1
  fi
  prior_revision="${BASH_REMATCH[1]}"
  if ! verify_report_worker_live "$prior_revision"; then
    echo "refusing activation: prior live deployment is not fully recoverable" >&2
    exit 1
  fi
elif report_worker_run_privileged test -e "/etc/systemd/system/$report_worker_service"; then
  echo "refusing activation: an unversioned report worker unit already exists" >&2
  exit 1
fi

if [[ "$prior_revision" == "$expected_revision" ]]; then
  echo "OpenSpell report worker release $expected_revision is already active and verified"
  exit 0
fi

activation_ok=false
if switch_report_worker_link "releases/$expected_revision" activation \
  && install_report_worker_unit "$release" "$expected_revision" \
  && report_worker_run_privileged systemctl daemon-reload \
  && report_worker_run_privileged systemctl enable "$report_worker_service" >/dev/null \
  && report_worker_run_privileged systemctl restart "$report_worker_service" \
  && verify_report_worker_live "$expected_revision"; then
  activation_ok=true
fi

if [[ "$activation_ok" != true ]]; then
  if [[ -n "$prior_revision" ]] && restore_report_worker_live "$prior_revision"; then
    echo "OpenSpell report worker activation failed; the prior deployment was fully restored" >&2
  else
    leave_report_worker_stopped
    echo "OpenSpell report worker activation failed; service remains stopped for attended recovery" >&2
  fi
  exit 1
fi

echo "activated OpenSpell report worker release $expected_revision"
