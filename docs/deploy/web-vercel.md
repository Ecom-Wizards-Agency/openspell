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

The release verifier requires the expected full SHA as an explicit environment
input. Before health, CDP, or cookies, it asks Vercel's fixed deployment API for
the candidate and requires an exact URL, project, owner, `production` target,
and `READY` match. This ensures promotion moves the verified production-target
artifact rather than rebuilding a preview with different environment inputs.
It then checks `/api/healthz` before opening CDP or requesting authenticated
routes. Any binding or revision failure stops with zero route checks.

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
the candidate hostname. Curl diagnostics are drained rather than retained
because transport output could include protected request details.

Candidate, expected-revision, and optional `OPENSPELL_CDP_URL` inputs are read
from validated environment variables. They are never package-script arguments,
so pnpm cannot repeat them in its command banner or failure summary. The checked-in
launcher removes `DEBUG`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`, `PWDEBUG`,
`NODE_OPTIONS`, and `NODE_V8_COVERAGE` before pnpm starts; the TypeScript entry
point repeats that boundary before importing the verifier. Existing approved
environment values named `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`,
and `VERCEL_AUTOMATION_BYPASS_SECRET` are required. They are captured, removed
from the process environment, and sent only through curl's stdin configuration.
The curl child receives only process lookup, temporary-directory, locale, proxy,
and certificate variables. Database, Amazon, release, CDP, provider, debug, and
unrelated variables are absent.

The immutable candidate URL is validated in its raw form before URL parsing. It
must use lowercase HTTPS on the exact project host, with no encoded aliases,
username, password, or explicit port (including `:443`). `OPENSPELL_CDP_URL` is a separate validated
HTTP(S) or WebSocket endpoint and may use a local or authenticated remote
transport. Neither value is printed. Any Playwright, CDP, URL-parser, stream, timeout,
or child-process exception becomes one fixed `OPENSPELL_RELEASE_ERROR:<code>`
diagnostic; dependency error messages are never printed.

Each request invokes system curl with the exact argv `--disable --config -`;
URLs, authorization, bypass, and cookies are never argv values. Curl's ambient
configuration is disabled and every request runs with a private,
known-empty `.curlrc`. Child runtime and diagnostic output are tightly bounded.
Response output has a 64 MiB hard ceiling, derived from the known 3,597-row grid
payload scaled to the product's 50,000-row cap with nearly threefold encoding
headroom; crossing it terminates the child. Health and the
public SVG forbid redirects. Account routes start with a direct request and may follow
only one raw, same-candidate canonical redirect that keeps the pathname and original
query byte-for-byte and prepends one lowercase canonical profile id. Cross-origin,
encoded, authority-changing, path-changing, query-reordering, cyclic, or
excess redirects fail without printing the `Location` value or profile id.

Only after the command exits successfully may the operator promote that same
in-memory candidate value:

```bash
vercel promote "$candidate_url"
```

After promotion, verify `/api/healthz` on the public alias reports the same full
revision, then complete the authenticated Chrome route sweep. A successful
candidate gate is not evidence that alias promotion or post-promotion QA ran.
