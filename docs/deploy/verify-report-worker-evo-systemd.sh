#!/usr/bin/env bash
set -euo pipefail

expected_revision="${1:-}"
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "usage: $0 <full-git-object-id>" >&2
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

if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "OpenSpell report worker system Node 22 or newer is unavailable" >&2
  exit 1
fi
command -v systemd-creds >/dev/null || {
  echo "OpenSpell report worker systemd-creds is unavailable" >&2
  exit 1
}
command -v git >/dev/null || {
  echo "OpenSpell report worker Git is unavailable" >&2
  exit 1
}
if ! assert_report_worker_transition_source; then
  echo "OpenSpell report worker transition helper is not from a clean tracked checkout" >&2
  exit 1
fi

acquire_report_worker_deployment_lock
verify_report_worker_credentials
assert_legacy_report_worker_retired
release="$report_worker_release_root/releases/$expected_revision"
if ! verify_report_worker_fenced_protocol "$release" "$expected_revision" \
  || ! verify_report_worker_database_contract "$release" \
  || ! verify_report_worker_fenced_authority "$release" \
  || ! verify_report_worker_live "$expected_revision"; then
  echo "OpenSpell report worker live deployment is incomplete or mismatched" >&2
  exit 1
fi

echo "OpenSpell report worker systemd deployment verified at revision $expected_revision"
