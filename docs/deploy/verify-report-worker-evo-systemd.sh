#!/usr/bin/env bash
set -euo pipefail

expected_revision="${1:-}"
if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; then
  echo "usage: $0 <full-git-object-id>" >&2
  exit 2
fi
if [[ ! -x /usr/local/bin/node ]] \
  || (( $(/usr/local/bin/node -p 'Number(process.versions.node.split(".")[0])') < 22 )); then
  echo "OpenSpell report worker system Node 22 or newer is unavailable" >&2
  exit 1
fi

release_root=/opt/openspell-report-worker
release="$release_root/releases/$expected_revision"
current_target="$(readlink "$release_root/current" 2>/dev/null || true)"
if [[ "$current_target" != "releases/$expected_revision" ]]; then
  echo "OpenSpell report worker current release does not match the expected revision" >&2
  exit 1
fi

verify_artifact() {
  local target="$1"
  local expected="$2"
  local counts actual_directories actual_files actual_links directories links
  [[ "$(cat "$target/REVISION" 2>/dev/null || true)" == "$expected" ]] || return 1
  [[ "$(cat "$target/public.conf" 2>/dev/null || true)" == \
    "OPENSPELL_WORKER_REVISION=$expected"$'\n'"WORKER_DEPLOYMENT_ROLE=evo-report-lane"$'\n'"WORKER_JOB_TYPES=creative.sync,report.request,report.poll,report.fetch" ]] \
    || return 1
  (cd "$target" && sha256sum -c ARTIFACT_SHA256 >/dev/null) || return 1
  counts="$(cat "$target/ARTIFACT_COUNTS" 2>/dev/null || true)"
  actual_directories="$(find "$target" -type d | wc -l)"
  actual_files="$(find "$target" -type f | wc -l)"
  actual_links="$(find "$target" -type l | wc -l)"
  [[ "$counts" == "directories=$actual_directories"$'\n'"files=$actual_files"$'\n'"symlinks=$actual_links" ]] \
    || return 1
  if find "$target" \( -type f -o -type d \) -perm /022 -print -quit | grep -q . \
    || find "$target" -xdev \( ! -user root -o ! -group root \) -print -quit | grep -q .; then
    return 1
  fi
  directories="$(mktemp /tmp/openspell-report-worker-directories.XXXXXX)"
  (cd "$target" && find . -type d -printf '%P\n' | LC_ALL=C sort >"$directories")
  diff -u "$target/ARTIFACT_DIRECTORIES" "$directories" >/dev/null || return 1
  find "$directories" -delete 2>/dev/null || true
  links="$(mktemp /tmp/openspell-report-worker-links.XXXXXX)"
  (cd "$target" && find . -type l -printf '%P\t%l\n' | LC_ALL=C sort >"$links")
  diff -u "$target/ARTIFACT_LINKS" "$links" >/dev/null || return 1
  find "$links" -delete 2>/dev/null || true
  while IFS= read -r -d '' link_path; do
    case "$(readlink -f "$link_path" 2>/dev/null || true)" in
      "$target"/*) ;;
      *) return 1 ;;
    esac
  done < <(find "$target" -type l -print0)
}

if ! verify_artifact "$release" "$expected_revision"; then
  echo "OpenSpell report worker retained artifact is incomplete or mismatched" >&2
  exit 1
fi
if ! cmp -s "$release/systemd/openspell-report-worker.service" \
  /etc/systemd/system/openspell-report-worker.service; then
  echo "OpenSpell report worker live unit differs from the retained release" >&2
  exit 1
fi
systemd-analyze verify "$release/systemd/openspell-report-worker.service"
systemctl is-enabled --quiet openspell-report-worker.service
systemctl is-active --quiet openspell-report-worker.service

health="$release_root/current/bin/openspell-report-worker-health.mjs"
/usr/local/bin/node "$health" \
  http://127.0.0.1:3000/healthz "$expected_revision" 1

echo "OpenSpell report worker systemd deployment verified at revision $expected_revision"
