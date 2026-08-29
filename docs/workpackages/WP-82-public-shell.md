# WP-82 — Quiet public application shell

## Goal

Remove the full operator navigation from anonymous routes while preserving a clear sign-in path,
theme control, brand identity and the complete task navigation after authentication.

## Boundary

- `apps/web` frame composition, frame styles and their tests only.
- Existing brand tokens and components are reused; no new palette or type choice.
- Anonymous `/` joins the existing guarded-route behavior by redirecting to login; session, data,
  database, migration, worker and Amazon behavior remain unchanged.

## Acceptance

- [x] Anonymous pages render a compact brand header with theme and sign-in controls.
- [x] Anonymous `/` requests go directly to login instead of rendering guarded route cards.
- [x] The public header does not render links to guarded operator routes.
- [x] Authenticated pages retain the complete operator sidebar, profile switcher and identity menu.
- [x] Public content spans the viewport instead of retaining an empty sidebar offset.
- [x] Unit and browser tests distinguish anonymous and authenticated frames.
- [x] No Amazon write API is invoked.
