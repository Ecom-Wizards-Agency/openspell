# WP-15 — Feedback & roadmap

**Owner:** Claude Opus · **Phase:** v1 · **Depends on:** WP-01 (db), WP-04 (auth/roles, merged first) · **Requested by operator 2026-08-14**

## Goal

All product feedback in one place, inside the tool: a simple bug-report / feature-request
form, a tracked backlog, and a roadmap page with upvoting. Internal-first (team = the users),
SaaS-ready (org-scoped like everything else).

## Spec

1. **Schema (one additive migration + `packages/db/src/queries/feedback.ts`):**
   - `feedback_items` (id, org_id, author user_id, type `bug|feature`, title, body,
     severity `low|medium|high|critical` nullable — bugs only, status
     `new|triaged|planned|in_progress|shipped|declined`, admin_note text nullable,
     page_context jsonb — capturing URL/route, profile id, app version when submitted from
     the widget, created_at, updated_at, status_changed_at).
   - `feedback_votes` (item_id, user_id, created_at; unique (item_id, user_id)).
   - RLS: org members read all org items, insert their own items/votes, delete their own
     vote; only owner|admin update status/admin_note; authors may edit their own title/body
     while status = `new`.
2. **Submit surface (`apps/web`):** a lightweight "Feedback" entry point available from any
   page (header button → modal or `/feedback/new`): type toggle, title, description,
   severity (bugs), and auto-attached page context (current route + selected profile,
   shown to the user before submit). No file uploads in v1.
3. **Tracker (`/feedback`):** list with filters (type, status, sort by votes/newest), item
   detail with vote toggle, admin-only status + note editing inline. Counts visible
   (N open bugs / M requests).
4. **Roadmap (`/roadmap`):** three columns — Planned / In progress / Shipped — fed from the
   same items (status ∈ planned|in_progress|shipped), ordered by votes, each card showing
   vote count + vote toggle; `declined` items visible under a collapsed "not planned" section
   with the admin note (honesty beats silence).
5. **MCP (small):** add ONE tool to `apps/mcp`: `submit_feedback` (type, title, body,
   severity?) writing the same table with actor_type `mcp` in page_context — AdLabs-parity
   with their `submit_bug_report`, audit-logged like every call. (Coordinate: apps/mcp is
   WP-09-owned but merged; additive tool file + registration only.)
6. Keep it boring: server actions + the existing auth/roles helpers from WP-04; no realtime,
   no email, no public portal in v1 (SaaS-ready = the org scoping, nothing more).

## Acceptance checks

- Submit a bug from a profile page → item carries the page context; appears in `/feedback`
  filtered views; counts correct.
- Voting: toggle on/off, unique per user (DB constraint test + UI), roadmap order follows
  votes.
- Roles: viewer/analyst can submit + vote but not change status (403 + no controls);
  admin status change moves the card between roadmap columns; declined shows the note.
- RLS negatives: org A cannot read/vote org B items (DB + HTTP layers).
- `submit_feedback` MCP tool writes an item and an audit_log row (test).
- Playwright: submit → vote → triage → roadmap flow green.
- `pnpm check` green; branch `wp-15-feedback`; report per acceptance check.
