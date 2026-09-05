# WP-212 — Repository overview for an external collaborator

Owner: implementer. Claude delivered the first version of `docs/OVERVIEW.md` on 2026-09-05;
this package keeps it truthful and fixes the stale documentation it exposed.

Depends on: decision D6 in `docs/workpackages/REPLAN-2026-09-05.md`. Answered on 2026-09-05:
the collaborator's features and working frontend parts are merged into OpenSpell; this
monorepo stays the target and stays public.

## Objective

Give an external collaborator, who has built their own Amazon Ads tool, one document that lets
them understand OpenSpell well enough to map their features onto it, and give the operator the
same template to receive the collaborator's inventory. Describe the boundaries as they are in
code, not as the older documents intend.

## Owned files

- `docs/OVERVIEW.md` (maintain; regenerate the scripted appendices on every change);
- `supabase/README.md` (stale "Fly worker" wording);
- `apps/analyst/README.md` (stale host and helper references);
- `AGENTS.md`: only the package boundary table, additive rows for `apps/analyst`,
  `packages/datadive-api`, `packages/keepa-api`, `packages/mrp-api`, `packages/sp-api`,
  `tools/adlabs-backfill`, `tools/skill-lint`, `tools/hosted-migration-*`;
- `README.md` quickstart line that says CI runs "the same four steps" (it runs five);
- this brief.

## Required behavior

1. Every inventory table in `docs/OVERVIEW.md` is produced by a command recorded in its appendix
   and pasted verbatim: workspace packages, Drizzle tables per domain, migration list with the
   five unhosted files flagged, job types, MCP tools, web pages and route handlers, environment
   variable names per app, CI workflows. Counts in prose are never typed by hand.
2. The Amazon boundary section states the actual runtime boundary: the Vercel cron route builds
   the Ads client and runs `entity.sync` and, unless the lane flag is set, `report.*` jobs; the
   web tier therefore holds the LWA client secret and reads refresh tokens through the Vault RPC.
   Cite `apps/web/app/api/cron/sync/route.ts` and `apps/worker/src/ads-api.ts`.
3. The merge-guidance section explains where an incoming feature lands: contracts in
   `packages/shared`, queries in `packages/db`, pure logic in `packages/core`, UI in `apps/web`
   consuming `packages/ui`, Amazon calls only through `apps/worker`, and the write contract in
   `AGENTS.md`. It lists the hazards from finding F10 and the overview lane: custom Postgres
   queue with two schedulers, service-role web database access with app-level roles, Supabase
   Vault and pg_cron dependence, doctrine values as tenant rows guarded by the hygiene linter,
   raw `.ts` workspace packages with `.js` specifiers under webpack, and goldens generated from a
   private Python repository.
4. The "what we need from you" section is a fillable template the collaborator returns:
   feature list with screenshots, data sources and API scopes, data model, queue or scheduler,
   auth model, deployment, tests, and the three or four screens they consider best.
5. Fix the stale text in the owned files without changing any rule in `AGENTS.md`.
6. Run `pnpm hygiene` with the changed files staged; the overview must contain no client names,
   profile identifiers, secrets, thresholds or absolute operator paths.

## Acceptance

1. Each appendix table reproduces from its recorded command on current main.
2. The boundary section cites the two files above and matches them.
3. `AGENTS.md` diff is limited to added table rows; `pnpm check` and `pnpm hygiene` pass.
4. The operator has confirmed the document is safe to hand over.
