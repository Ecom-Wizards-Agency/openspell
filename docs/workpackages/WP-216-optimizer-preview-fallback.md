# WP-216 — Optimizer preview legacy fallback

Owner: implementer.

Depends on: decision D2 in `docs/workpackages/REPLAN-2026-09-05.md`. Must be merged before
WP-213 deploys web from main. Requires `20260901050000` and `20260901060000` hosted (WP-207)
before that deploy, because the runner writes the scope columns and the admission trigger
validates the run row.

## Objective

Keep the Optimizer "Run preview" working after a main deploy. On main the two preview routes
return 503 unless the fenced recommendation lane is fully live, which is weeks away (finding F2).
At the deployed revision `44da7ac` the same routes have no gate and the Vercel cron runs the
preview job. Restore that behavior as an explicit legacy mode while keeping the fenced mode
intact for later.

## Owned files

- `packages/db/src/queries/recommendation-readiness.ts` and its test;
- `apps/web/app/api/optimizer/runs/route.ts` and `apps/web/app/api/optimizer/groups/run/route.ts`
  and their tests;
- the module that exports `OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE` (copy only);
- `docs/STATUS.md` one row;
- this brief.

Do not edit `apps/web/app/optimizer/page.tsx` or `campaign-workspace.tsx`; they belong to WP-209.

## Required behavior

1. `resolveOptimizerPreviewReadiness` returns `{ ready: true, mode: 'legacy' }` when
   `OPENSPELL_RECOMMENDATION_LANE_READY` is unset or `0`. In that mode the Vercel cron is the only
   claimant of `recommendations.run`, exactly as at `44da7ac`, so there is no overlapping consumer.
2. When the variable is `1` the existing fenced checks apply unchanged and return
   `{ ready: true, mode: 'fenced' }` or the existing refusal reasons.
3. An invalid value still fails closed with 503 and reason `misconfigured`.
4. Both routes include `mode` in their accepted response so the UI and logs can tell the modes
   apart. The 503 message stays for fenced-mode refusals.
5. Legacy mode must still create the `recommendation_runs` row and the `recommendations.run` job
   in one transaction with the scope columns populated, so the `20260901060000` admission trigger
   accepts the insert. Add a test that inserts through the store against a database with all 46
   migrations applied and asserts the trigger accepts it.
6. The `packages/shared` contracts are not changed. If the response shape needs a contract, stop
   and report.

## Acceptance

1. Unit tests cover unset, `0`, `1` with each fenced refusal, and an invalid value.
2. Route tests prove 202 in legacy mode, 503 with the existing message in fenced refusals, and
   503 on misconfiguration.
3. The database test in step 5 passes on the 46-file schema.
4. `pnpm check` passes.

## Do not

- Remove or weaken any fenced-mode check.
- Add a hosted setting, deployment or activation; WP-213 owns the deploy.
