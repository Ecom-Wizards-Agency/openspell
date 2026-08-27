# WP-49 — Bug/Roadmap split (retire the generic Feedback page)

**Status:** open · **Owner:** Codex (gpt-5.6-sol) · **Branch:** `wp-49-bug-split`

## Why

Operator: "Feedback is not = bug. Bug is bug. Most of the feedback things are roadmap
things. Bugs are e.g. 'Campaign Optimizer is not loading'." The product should have two
surfaces — **Bugs** (operational failures) and **Roadmap** (features/requests) — and no
generic "Feedback" page. Data model unchanged: `feedback_items.type` already separates
bug|feature. IA/surface work only.

## Scope

1. **/bugs becomes the bug home** (`apps/web/app/bugs/`): fold the admin triage controls
   from the feedback tracker (`apps/web/app/feedback/tracker.tsx` — status select, admin
   note, mark-duplicate, severity display) into the bug board/cards for
   `triageFeedback`-capable users; keep votes; bug items only. The Bug widget stays
   bug-only and its success toast keeps linking here.
2. **/roadmap gains feature intake + votes** (`apps/web/app/roadmap/`): a "Request a
   feature" affordance → reuse the /feedback/new form with type=feature preselected (and
   hide the type toggle when preselected); feature-item triage (status/admin note) moves
   here for admins (the existing board already renders by status); votes visible.
3. **Retire /feedback**:
   - Remove the Feedback nav entry (`apps/web/src/ui/nav-links.ts` product group now:
     Bugs, Roadmap).
   - `/feedback` route → redirect: to /bugs (default). `/feedback#feedback-<id>` style
     deep links and any `/feedback?...` links: keep a thin server component that looks up
     the item type and redirects bug→/bugs#bug-<id>, feature→/roadmap (anchor if the
     board supports it).
   - `/feedback/new` STAYS (it's the shared intake form) but its copy adapts to the
     preselected type; entry points: widget "Full form →" (bug) and roadmap intake
     (feature).
4. **Update the mentions**: MCP `submit_feedback` tool description (bug vs feature
   routing — `apps/mcp/src/feedback.ts` registration text only, no contract change);
   guards.spec GUARDED list (drop /feedback, keep /feedback/new, /bugs, /roadmap);
   `apps/web/e2e/feedback.spec.ts` flows (triage now happens on /bugs and /roadmap);
   any links pointing at /feedback (grep).
5. Do NOT touch: feedback_items schema, /api/feedback routes, the dedup seam, the
   roadmap-status rule (cards stay in_progress until the operator flips them).

## Constraints

- Read AGENTS.md; program rules bind. No schema/migrations, no `packages/shared` edits.
- Branch `wp-49-bug-split`; commits `feat(wp-49): ...`; no push/merge.
- Verify: `pnpm typecheck && pnpm lint && pnpm test` green; e2e specs updated and
  passing where runnable (state exactly what ran).
- Final message: what shipped, redirect behavior, e2e status, screenshots-worthy states.
