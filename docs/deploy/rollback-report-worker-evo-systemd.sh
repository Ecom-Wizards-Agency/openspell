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
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "refusing rollback: system Node 22 or newer is unavailable" >&2
  exit 1
fi

release_root=/opt/openspell-report-worker
current_link="$release_root/current"
from_target="releases/$from_revision"
to_target="releases/$to_revision"
if [[ "$(sudo readlink "$current_link" 2>/dev/null || true)" != "$from_target" ]]; then
  echo "refusing rollback: current release no longer matches the expected revision" >&2
  exit 1
fi

verify_artifact() {
  local target="$1"
  local expected="$2"
  local counts actual_directories actual_files actual_links directories links
  [[ "$(sudo cat "$target/REVISION" 2>/dev/null || true)" == "$expected" ]] || return 1
  [[ "$(sudo cat "$target/public.conf" 2>/dev/null || true)" == \
    "OPENSPELL_WORKER_REVISION=$expected"$'\n'"WORKER_DEPLOYMENT_ROLE=evo-report-lane"$'\n'"WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch" ]] \
    || return 1
  sudo sh -c 'cd "$1" && sha256sum -c ARTIFACT_SHA256 >/dev/null' sh "$target" \
    || return 1
  counts="$(sudo cat "$target/ARTIFACT_COUNTS" 2>/dev/null || true)"
  actual_directories="$(sudo find "$target" -type d | wc -l)"
  actual_files="$(sudo find "$target" -type f | wc -l)"
  actual_links="$(sudo find "$target" -type l | wc -l)"
  [[ "$counts" == "directories=$actual_directories"$'\n'"files=$actual_files"$'\n'"symlinks=$actual_links" ]] \
    || return 1
  if sudo find "$target" \( -type f -o -type d \) -perm /022 -print -quit | grep -q . \
    || sudo find "$target" -xdev \( ! -user root -o ! -group root \) -print -quit \
      | grep -q .; then
    return 1
  fi
  directories="$(mktemp /tmp/openspell-report-worker-rollback-directories.XXXXXX)"
  (cd "$target" && find . -type d -printf '%P\n' | LC_ALL=C sort >"$directories")
  sudo diff -u "$target/ARTIFACT_DIRECTORIES" "$directories" >/dev/null || {
    find "$directories" -delete 2>/dev/null || true
    return 1
  }
  find "$directories" -delete 2>/dev/null || true
  links="$(mktemp /tmp/openspell-report-worker-rollback-links.XXXXXX)"
  (cd "$target" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort >"$links")
  sudo diff -u "$target/ARTIFACT_LINKS" "$links" >/dev/null || {
    find "$links" -delete 2>/dev/null || true
    return 1
  }
  find "$links" -delete 2>/dev/null || true
  while IFS= read -r -d '' link_path; do
    case "$(sudo readlink -f "$link_path" 2>/dev/null || true)" in
      "$target"/*) ;;
      *) return 1 ;;
    esac
  done < <(sudo find "$target" -type l -print0)
}

for pair in "$from_target:$from_revision" "$to_target:$to_revision"; do
  target="${pair%%:*}"
  expected="${pair#*:}"
  if ! verify_artifact "$release_root/$target" "$expected"; then
    echo "refusing rollback: retained release provenance is invalid" >&2
    exit 1
  fi
  if ! sudo systemd-analyze verify \
    "$release_root/$target/systemd/openspell-report-worker.service"; then
    echo "refusing rollback: retained release unit is invalid" >&2
    exit 1
  fi
done

switch_link() {
  local target="$1"
  local temporary="$release_root/.current-rollback"
  sudo ln -sfn "$target" "$temporary"
  sudo mv -Tf "$temporary" "$current_link"
}
install_release_unit() {
  local target="$1"
  local suffix="$2"
  local unit_stage="/etc/systemd/system/.openspell-report-worker.service.$suffix"
  sudo install -m 0644 -o root -g root \
    "$release_root/$target/systemd/openspell-report-worker.service" "$unit_stage" \
    && sudo mv -Tf "$unit_stage" /etc/systemd/system/openspell-report-worker.service
}
restore_original() {
  sudo systemctl stop openspell-report-worker.service >/dev/null 2>&1 || true
  switch_link "$from_target" || return 1
  install_release_unit "$from_target" "$from_revision" || return 1
  sudo systemctl daemon-reload || return 1
  sudo systemctl enable openspell-report-worker.service >/dev/null || return 1
  sudo systemctl restart openspell-report-worker.service || return 1
  /usr/local/bin/node \
    "$release_root/current/bin/openspell-report-worker-health.mjs" \
    http://127.0.0.1:3000/healthz "$from_revision" 120 || return 1
}

switch_link "$to_target"
if ! install_release_unit "$to_target" "$to_revision" \
  || ! sudo systemctl daemon-reload \
  || ! sudo systemctl enable openspell-report-worker.service >/dev/null \
  || ! sudo systemctl restart openspell-report-worker.service \
  || ! /usr/local/bin/node \
    "$release_root/current/bin/openspell-report-worker-health.mjs" \
    http://127.0.0.1:3000/healthz "$to_revision" 120; then
  if restore_original; then
    echo "OpenSpell report worker rollback failed; the original deployment was restored" >&2
  else
    sudo systemctl stop openspell-report-worker.service >/dev/null 2>&1 || true
    echo "OpenSpell report worker rollback failed; service remains stopped for manual recovery" >&2
  fi
  exit 1
fi

echo "rolled OpenSpell report worker back from $from_revision to $to_revision"
