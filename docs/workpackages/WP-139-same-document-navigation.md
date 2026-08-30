# WP-139 — Same-document operator navigation

## Outcome

Profile switches, date presets and custom ranges, sidebar links, Grid entity
changes, and Grid experiment links use the Next App Router. Routine operator
navigation therefore keeps the application document and client state alive while
the destination server component loads.

Automatic prefetch is disabled for known server-heavy analytical routes so opening
the navigation does not create hidden database work. Utility routes keep the
framework default.

## Acceptance checks

- Profile, date, and Grid route state survive navigation.
- The profile cookie is written before the profile transition begins.
- Back and forward navigation retain the active profile.
- A browser document marker survives the complete sequence and no additional
  document request occurs.
- Typecheck, lint, tests, hygiene, production build, and diff checks pass.

This package does not claim to reduce server-query time or rendered data payloads;
those are separate measured work packages. It adds no telemetry endpoint and makes
no database, Amazon API, credential, or tenant-strategy change.
