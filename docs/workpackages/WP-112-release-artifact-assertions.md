# WP-112 — Release artifact assertions

## Purpose

The immutable Vercel candidate gate must distinguish the current OpenSpell UI
from an older deployment that still returns successful authenticated pages and
generic headings.

## Contract

- Candidate requests remain GET-only.
- Only an exact immutable OpenSpell Vercel hostname is accepted.
- Authentication cookies remain in memory and enter curl through stdin config;
  response bodies, cookie names, and cookie values never enter the report.
- Every route requires all named artifacts and rejects application, login, and
  alert surfaces.
- The official public OpenSpell SVG must return HTTP 200 and match its tracked
  dimensions and distinctive gradient signature.
- The grid requires its active-account context and date-range picker, not only a
  heading.
- Recommendations carries a non-visible version marker on every data state so
  the focused filter/action workflow can be verified without depending on a
  particular profile having proposals at deployment time.

The verifier reports only missing public artifact identifiers. It never reports
the authenticated response body.

## Acceptance checks

- A stale grid response with the old heading but without the operator context
  and date picker fails.
- A missing, non-SVG, or non-200 official brand asset fails.
- A stale recommendations response with only the heading fails.
- Current grid server markup and the focused recommendations marker pass.
- An authenticated error surface fails even when all required strings appear.
- Typecheck, lint, unit tests, and public-repository hygiene pass.
- No deployment, promotion, mutation request, migration, seed, or Amazon API
  call is made by this package.
