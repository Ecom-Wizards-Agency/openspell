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

for command in cmp flock git readlink sudo systemctl systemd-analyze systemd-creds; do
  command -v "$command" >/dev/null || {
    echo "refusing activation: required command is unavailable: $command" >&2
    exit 1
  }
done
if ! assert_report_worker_transition_source "$expected_revision"; then
  echo "refusing activation: transition helper is not from a clean tracked checkout" >&2
  exit 1
fi
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "refusing activation: system Node 22 or newer is unavailable" >&2
  exit 1
fi

acquire_report_worker_deployment_lock
verify_report_worker_credentials
assert_legacy_report_worker_retired

release="$report_worker_release_root/releases/$expected_revision"
if ! verify_report_worker_fenced_protocol "$release" "$expected_revision"; then
  echo "refusing activation: staged release does not advertise the exact fenced protocol" >&2
  exit 1
fi
if ! verify_report_worker_database_contract "$expected_revision"; then
  echo "refusing activation: hosted database does not expose the exact fenced contract" >&2
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
  if ! verify_report_worker_fenced_protocol \
    "$report_worker_release_root/releases/$prior_revision" "$prior_revision"; then
    echo "refusing activation: prior deployment is not a fenced recovery destination" >&2
    exit 1
  fi
elif ! assert_report_worker_exact_absence; then
  echo "refusing activation: first activation did not start from exact service absence" >&2
  exit 1
fi

if [[ "$prior_revision" == "$expected_revision" ]]; then
  if ! verify_report_worker_fenced_authority "$expected_revision"; then
    echo "refusing activation: active release does not have fenced database authority" >&2
    exit 1
  fi
  echo "OpenSpell report worker release $expected_revision is already active and verified"
  exit 0
fi

if [[ -n "$prior_revision" ]] && ! stop_report_worker_and_prove_inactive; then
  echo "refusing activation: prior report worker did not become inactive" >&2
  exit 1
fi
if ! custody_before="$(capture_report_worker_custody_snapshot "$expected_revision")" \
  || ! assert_report_worker_custody_drained "$custody_before"; then
  if leave_report_worker_stopped; then
    echo "refusing activation: report-lane custody is unresolved; the service is inactive and disabled" >&2
  else
    echo "refusing activation: report-lane custody is unresolved and service inactivity could not be proved" >&2
  fi
  exit 1
fi

authority_result=
authority_activated=false
if authority_result="$(activate_report_worker_fenced_authority "$expected_revision")" \
  && assert_report_worker_authority_activated "$authority_result"; then
  authority_activated=true
elif verify_report_worker_fenced_authority "$expected_revision"; then
  # The activation RPC may have committed even if its response was lost. The
  # read-only authority proof below contains that ambiguity without reversing it.
  authority_activated=true
fi
if [[ "$authority_activated" != true ]]; then
  if leave_report_worker_stopped; then
    echo "refusing activation: fenced database authority was not established; the service is inactive and disabled" >&2
  else
    echo "refusing activation: fenced database authority was not established and service inactivity could not be proved" >&2
  fi
  exit 1
fi
if ! verify_report_worker_fenced_authority "$expected_revision" \
  || ! custody_before="$(capture_report_worker_custody_snapshot "$expected_revision")" \
  || ! assert_report_worker_custody_drained "$custody_before"; then
  if leave_report_worker_stopped; then
    echo "refusing activation: fenced authority and drained custody were not jointly re-proved; authority is not automatically reverted and the service is inactive and disabled" >&2
  else
    echo "refusing activation: post-authority safety could not be proved and service inactivity could not be proved; authority is not automatically reverted" >&2
  fi
  exit 1
fi

activation_ok=false
if switch_report_worker_link "releases/$expected_revision" activation \
  && install_report_worker_unit "$release" "$expected_revision" \
  && report_worker_run_privileged systemctl daemon-reload \
  && report_worker_run_privileged systemctl enable "$report_worker_service" >/dev/null \
  && report_worker_run_privileged systemctl start "$report_worker_service" \
  && verify_report_worker_live "$expected_revision"; then
  activation_ok=true
fi

if [[ "$activation_ok" != true ]]; then
  if ! leave_report_worker_stopped; then
    echo "OpenSpell report worker activation failed and candidate inactivity could not be proved; no automatic restoration was attempted" >&2
    exit 1
  fi
  custody_after=
  if custody_after="$(capture_report_worker_custody_snapshot "$expected_revision")" \
    && restore_report_worker_state_if_unchanged \
      "$custody_before" "$custody_after" "$prior_revision"; then
    if [[ -n "$prior_revision" ]]; then
      echo "OpenSpell report worker activation failed before a claim; the prior deployment was fully restored" >&2
    else
      echo "OpenSpell report worker activation failed before a claim; exact service absence was restored" >&2
    fi
  else
    if leave_report_worker_stopped; then
      echo "OpenSpell report worker activation failed with ambiguous custody; the service is inactive and disabled for attended recovery" >&2
    else
      echo "OpenSpell report worker activation recovery failed and service inactivity could not be proved" >&2
    fi
  fi
  exit 1
fi

echo "activated OpenSpell report worker release $expected_revision"
