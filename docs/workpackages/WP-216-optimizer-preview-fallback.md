# WP-216 — Optimizer preview legacy fallback

Owner: Claude for implementation. GPT supplies the reviewed handoff, per the operator's
2026-09-05 ownership update.

Depends on: decision D2 in `docs/workpackages/REPLAN-2026-09-05.md`. Must be merged before
WP-213 deploys web from main. Requires `20260901050000` and `20260901060000` hosted (WP-207)
before that deploy, because the runner writes the scope columns and the admission trigger
validates the run row.

## Objective

Keep the Optimizer "Run preview" working after a main deploy. On main the two preview routes
return 503 unless the fenced recommendation lane is fully live; that activation is unfinished
(finding F2).
At the deployed revision `44da7ac` the same routes have no gate and the Vercel cron runs the
preview job. Restore that behavior as an explicit legacy mode while keeping the fenced mode
intact for later.

## Owned files

- `packages/db/src/queries/recommendation-readiness.ts` and its test;
- `apps/web/app/api/optimizer/runs/route.ts` and `apps/web/app/api/optimizer/groups/run/route.ts`
  and their tests;
- the module that exports `OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE` (copy only);
- `apps/worker/src/recommendation-schedule-readiness.test.ts` and the existing preview
  integration tests in `apps/worker/src/recommendations-run.test.ts`;
- `apps/web/app/api/cron/sync/route.test.ts` for manual/scheduled ownership regression checks;
- this brief.

Do not edit `apps/web/app/optimizer/page.tsx` or `campaign-workspace.tsx`; they belong to WP-209.

## Required behavior

1. When `OPENSPELL_RECOMMENDATION_LANE_READY` is unset or `0`, query the database authority.
   Return `{ ready: true, mode: 'legacy' }` only for exactly one valid row with legacy protocol
   and legacy admission. Unavailable, blocked, fenced, scoped or malformed authority fails
   closed. Unsetting an environment variable must never bypass a database cutover: after fenced
   activation the legacy claim SQL excludes `recommendations.run`.
   Vercel cron owns the manual preview jobs; verify the deployed worker job sets rather than
   inferring exclusivity from a producer flag.
2. When the variable is `1` the existing fenced checks apply unchanged and return
   `{ ready: true, mode: 'fenced' }` or the existing refusal reasons.
3. An invalid value still fails closed with 503 and reason `misconfigured`.
4. Both routes include `mode` in their accepted response so the UI and logs can tell the modes
   apart. The 503 message stays for fenced-mode refusals.
5. Legacy mode must still create the `recommendation_runs` row and the `recommendations.run` job
   in one transaction with the scope columns populated, so the `20260901060000` admission trigger
   accepts the insert. Add a test that inserts through the store against a database with all 46
   migrations applied and asserts the trigger accepts it.
6. Keep scheduled previews explicitly opted in. The shared readiness helper also gates the
   general-worker scheduler, while cron independently checks enabled lane intent. Give manual
   legacy readiness and scheduled fenced readiness separate decisions so changing the manual
   route cannot activate a second scheduler. Add negative tests for both scheduler call sites.
   Include a helper change in this owned file if needed; do not widen scheduler admission by
   accident.
7. Add `mode` to the authoritative response contract if consumers validate a strict shared
   response schema. Land that small contract slice before the route change and declare its exact
   file scope; do not duplicate the contract locally. Record close-out in this brief for the
   current STATUS owner to integrate.

## Acceptance

1. Unit tests cover unset/`0` with each authority state, enabled fenced mode with each refusal,
   malformed/missing authority, and invalid environment values. Scheduled readiness retains its
   prior gates in both cron and the general worker.
2. Route tests prove 202 in legacy mode, 503 with the existing message in fenced refusals, and
   503 on misconfiguration.
3. Both manual routes create exact scoped work on the 46-file legacy schema; the legacy worker
   claims it, runs it and persists the counted result. Missing authority and post-cutover flag
   reversal fail closed before enqueue. The database test in step 5 passes.
4. `pnpm check` passes.

## Do not

- Remove or weaken any fenced-mode check.
- Add a hosted setting, deployment or activation; WP-213 owns the deploy.
