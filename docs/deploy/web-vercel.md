# OpenSpell web release through an immutable Vercel candidate

This runbook keeps the public alias on its last verified build until an
immutable candidate proves both its exact source revision and its authenticated
operator artifacts. It does not authorize a database migration or Amazon API
write.

## Revision contract

`GET /api/healthz` is public and returns only:

```json
{
  "product": "OpenSpell",
  "status": "ready",
  "revision": "0000000000000000000000000000000000000000"
}
```

Vercel's built-in `VERCEL_GIT_COMMIT_SHA` is authoritative when present. A
non-secret `OPENSPELL_APP_VERSION` can supply the same full commit SHA for a
runtime without Vercel metadata; the legacy `WIZARD_ADS_APP_VERSION` remains a
fallback during the product-name transition. A short hash, label, missing value,
or non-hex value becomes `null`. The response is `no-store` and never includes a
runtime URL, deployment identifier, environment name, database state, or secret.

The release verifier requires the expected full SHA as an explicit argument.
It checks `/api/healthz` before opening the CDP connection or requesting any
authenticated route. Missing, malformed, or different revisions stop the gate
with zero route checks.

## Candidate gate

Start from a clean checkout of the approved commit. Keep the immutable URL in a
shell variable so it does not enter a tracked file or the structured report:

```bash
test -z "$(git status --short)"
release_revision="$(git rev-parse HEAD)"
test "${#release_revision}" = 40
candidate_url="$(vercel deploy --prod --skip-domain \
  --build-env "OPENSPELL_APP_VERSION=$release_revision" \
  --env "OPENSPELL_APP_VERSION=$release_revision")"
OPENSPELL_RELEASE_CANDIDATE_URL="$candidate_url" \
OPENSPELL_RELEASE_EXPECTED_REVISION="$release_revision" \
  bash apps/web/scripts/verify-release-candidate.sh
```

The report identifies the target only as `immutable-candidate`; it includes the
public expected and observed Git revisions plus named route assertions, but not
the candidate hostname. Vercel CLI diagnostics are drained rather than retained
because future CLI output could include protected request details.

Candidate, expected-revision, and optional `OPENSPELL_CDP_URL` inputs are read
from validated environment variables. They are never package-script arguments,
so pnpm cannot repeat them in its command banner or failure summary. The checked-in
launcher removes `DEBUG`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`, and `PWDEBUG` before
pnpm starts; the TypeScript entry point removes them again before it imports
Playwright or starts Vercel. The Vercel child receives an explicit environment
allowlist containing only process lookup, Vercel authentication/config location,
proxy, and certificate variables. Database, Amazon, release, CDP, debug, and
unrelated variables are absent.

The immutable candidate URL must use HTTPS on the exact project host, with no
username, password, or explicit port. `OPENSPELL_CDP_URL` is a separate validated
HTTP(S) or WebSocket endpoint and may use the local CDP port or authenticated remote
transport. Neither value is printed. Any Playwright, CDP, URL-parser, stream, timeout,
or child-process exception becomes one fixed `OPENSPELL_RELEASE_ERROR:<code>`
diagnostic; dependency error messages are never printed.

Each Vercel request disables curl's ambient configuration and runs with a private,
known-empty `.curlrc`. Child runtime, stdout, and stderr are bounded. Health and the
public SVG forbid redirects. Account routes start with a direct request and may follow
only a bounded, same-candidate canonical redirect that keeps the pathname/query and
adds one valid profile id. Cross-origin, path-changing, query-expanding, cyclic, or
excess redirects fail without printing the `Location` value or profile id.

Only after the command exits successfully may the operator promote that same
in-memory candidate value:

```bash
vercel promote "$candidate_url"
```

After promotion, verify `/api/healthz` on the public alias reports the same full
revision, then complete the authenticated Chrome route sweep. A successful
candidate gate is not evidence that alias promotion or post-promotion QA ran.
