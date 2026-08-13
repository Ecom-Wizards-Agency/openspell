# WP-08 — Nested tags + goto links (`apps/web`)

**Owner:** Codex · **Phase:** v1 · **Depends on:** WP-00/01; WP-06 filter interface; recon tag-UX spec (WP-11)

## Goal

AdLabs-style nested tags (also the client-grouping mechanism for ~200 profiles) and signed
goto deep links.

## Spec

1. **Tags:** CRUD for nested tags (`tags.parent_id`, color), tagging of profiles, campaigns,
   ad groups, keywords/targets (`entity_tags`); bulk tag-by-filter from the grid; tag filter
   integration with grid + dashboard via WP-06's filter interface. Org-scoped, RLS-checked.
2. **Goto links:** `POST` create → short signed token in `goto_links` (target route + filter
   state jsonb, expiry, creator); `/go/[token]` resolves, checks expiry + org membership,
   redirects into the exact filtered view. (These become the deep-link currency for the MCP
   and the later Keepa/BSR comparison views.)

## Acceptance checks

- Tag a campaign set → grid and dashboard filter by tag (Playwright).
- Nested tag rename/move keeps entity associations; delete offers reassign-or-detach.
- Goto link round-trips filter state exactly; expired token → 404; other-org token → 404.
- RLS: org A cannot see or resolve org B tags/links (negative tests).
- Branch `wp-08-tags-goto`; report per acceptance check.
