# WP-112 — Release artifact assertions

## Purpose

The immutable Vercel candidate gate must distinguish the current OpenSpell UI
from an older deployment that still returns successful authenticated pages and
generic headings.

## Contract

- Candidate requests remain GET-only.
- Only an exact immutable OpenSpell Vercel hostname is accepted.
- Public `GET /api/healthz` returns only OpenSpell readiness and one normalized
  full Git commit revision from Vercel build metadata or an explicit non-secret
  app-version fallback.
- The verifier binds the candidate to an exact ready Vercel deployment, project,
  and owner before health, CDP, or cookies. It then requires the expected full
  commit SHA as a separate explicit release input.
- Candidate, expected-revision, and CDP inputs never enter package-manager
  arguments. The root launcher clears Node/Playwright debug variables before
  pnpm, and the verifier clears them again before importing Playwright or
  starting transport.
- Direct system curl receives the static argv `--disable --config -`; URLs and
  authorization enter only through stdin. Its child gets a minimal environment and a private
  empty curl home. Runtime and output are bounded; stream failures use fixed
  diagnostic codes.
- Health and SVG checks forbid redirects. Account routes manually follow only
  bounded same-candidate canonical profile redirects; `Location` and profile
  values never enter the report.
- Dependency and unexpected exceptions map to fixed diagnostic codes. Their
  messages, endpoints, usernames, passwords, and hostnames are never printed.
- Authentication cookies remain in memory and enter curl through stdin config;
  response bodies, cookie names, and cookie values never enter the report.
- Every route requires all named artifacts and rejects application, login, and
  alert surfaces.
- The official public OpenSpell SVG must return HTTP 200 and match its tracked
  dimensions and distinctive gradient signature.
- An authenticated operator route must render the versioned official-mark DOM
  marker, proving the application uses the SVG asset instead of a text fallback.
- The grid requires its active-account context and date-range picker, not only a
  heading.
- Recommendations carries a non-visible version marker on every data state so
  the focused filter/action workflow can be verified without depending on a
  particular profile having proposals at deployment time.

The verifier reports only public revisions and missing public artifact identifiers.
It never reports the authenticated response body or immutable candidate hostname.

## Acceptance checks

- A stale grid response with the old heading but without the operator context
  and date picker fails.
- A missing, non-SVG, or non-200 official brand asset fails.
- An operator page that omits the official brand-mark DOM marker fails.
- A stale recommendations response with only the heading fails.
- Exact revision match passes; mismatch, missing revision, and malformed revision
  each fail with no authenticated route QA.
- A real pnpm subprocess regression proves a rejected credentialed candidate and
  credentialed CDP endpoint never appear in stdout or stderr.
- Adversarial launcher tests cover Node preload/debug logging, hostile curl config,
  unrelated inherited secrets, metadata mismatch/readiness/redirect, and a curl child failure. Redirect tests cover accepted
  same-origin canonicalization and rejected cross-origin/path/query redirects.
- Current grid server markup, official brand marker, and focused recommendations marker pass.
- An authenticated error surface fails even when all required strings appear.
- Typecheck, lint, unit tests, and public-repository hygiene pass.
- No deployment, promotion, mutation request, migration, seed, or Amazon API
  call is made by this package.
