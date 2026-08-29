#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

exec env \
  -u DEBUG \
  -u NODE_DEBUG \
  -u NODE_DEBUG_NATIVE \
  -u PWDEBUG \
  -u NODE_OPTIONS \
  -u NODE_V8_COVERAGE \
  pnpm --silent --filter @wizard-ads/web verify:release-candidate
