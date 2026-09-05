# Re-plan audit and corrections, 2026-09-05

Reviewed source: `560d5e2`. Original handoff commit: `1e62a92`. The audited handoff is
`REPLAN-2026-09-05.md`; work takes place on `wp-207-replan-audit`.

This review changes documentation and package scope. It does not implement or activate a write
path. No hosted database, deployment, credential store or Amazon account was accessed.

## Operator direction incorporated

- Claude Fable 5.1 owns frontend design, including the new write-preview client components.
- The operator expects to work with Claude on D1/WP-207 and D2/WP-216. GPT provides the
  corrected handoff and does not begin those implementations.
- The operator clarified that "API writes without MCP" means changing values through the
  OpenSpell UI and having OpenSpell send approved changes to Amazon. WP-214 supplies that
  flow first. WP-217 later adds bounded MCP access to the same worker service. A separate
  HTTP integration API for external scripts is out of scope. HTTP tests cover the UI backend.
- Source work, testing and review can proceed autonomously. A tested operational window can
  receive one scoped authorization for its exact targets and restoration steps; attendance and
  per-command confirmations are not technical requirements. Live bounds are not invented here.

## Findings incorporated into the briefs

| Finding | Evidence at the reviewed source | Correction |
|---|---|---|
| Main's parser rejects the old queue row shape | `packages/db/src/queries/job-wire.ts` lines 51-62; SQL completes before mapping at `packages/db/src/queries/jobs.ts` lines 34-39 | WP-207 must prove the durable running row/consumed attempt, recover it, then assert exactly one successful claim. Ordered upgrade is 41 to 44 to 46 files; five new ledger rows. Worker integration tests belong in `apps/worker`. |
| Legacy preview fallback cannot trust only an environment flag | `packages/db/src/queries/recommendation-readiness.ts` lines 44-79; `supabase/migrations/20260901060000_recommendation_claim_custody.sql` lines 921-926,1229-1231 | WP-216 requires fresh legacy/legacy database authority, refuses post-cutover flag reversal and keeps scheduled production separately gated. |
| Pinned pilot general role starts unrelated timers | `397eff8:apps/worker/src/deployment-role.ts` lines 112-129; `397eff8:apps/worker/src/main.ts` lines 122-147 | Use the report role on that exact pre-fencing revision. Do not substitute current main's fenced report role or general role without a reviewed replacement. |
| Pilot rollback can disable cron and strand creative work | `apps/worker/src/deployment-role.ts` lines 90-100; cron refusal at `apps/web/app/api/cron/sync/route.ts` lines 74-80 | Disable production, drain/account for SB-linked work while the SB-capable claimant exists, then restore report ownership. Producer-on/lane-off is invalid. |
| Pilot acceptance assumes nonexistent fields and uncontended timing | Historical health at `397eff8:apps/worker/src/health.ts` lines 7-12,52-55; producer counts at `packages/db/src/queries/creative-sync-producer.ts` lines 70-83,102,137-142; terminal status at `apps/worker/src/sb-video-ingestion.ts` lines 351-357 | Verify actual health fields, exactly one daily durable job and reconciled deduplication/pending counts. Distinguish intermediate `report_pending` from terminal `completed`. |
| Migration fingerprints can change after capture | `apps/worker/src/recommendation-observer.ts` lines 142-148; preserved fingerprint in [prefix-46.sql](../../tools/hosted-migration-bundle/sql/wp-197-hosted-migration-prefix-46.sql) lines 100-109 | Freeze producers, claimants and observation passes before the frozen preflight. Restore exact prior states after postflight. |
| Planned legacy-worker update uses a retired deployment path | `docs/deploy/always-on-worker.md` lines 30-44,72-74 | WP-213 keeps compatible worker releases pinned. WP-214 owns a dedicated immutable integration/write-worker release instead of an in-place checkout update. |
| F5's SQL permission claim was false | `supabase/migrations/20260901020000_sp_write_persistence_ledger.sql` lines 4116-4125 | Approval is granted to `authenticated`; staging/execution use `service_role`. The authenticated actor helper is appropriate, with production-safe transaction cleanup. |
| Source PR would fail the existing blast assertions | `packages/db/src/sp-write-persistence-blast.test.ts` lines 75-85,110-153; `packages/db/src/sp-write-persistence.test.ts` lines 8032 | Source PR allows exact inert modules while forbidding entrypoint registration. Activation changes only the deliberate registration allowance. Several HTTP helpers do not imply several provider executors. |
| Campaign creation releases dependants too early | `packages/shared/src/campaign-creation.ts` lines 2222-2241 | Persist an exact observed parent before child dispatch. End-only resync is insufficient. Pending/ambiguous creates must not be retried as new resources. |
| MCP amendment left contradictory approval rules | `AGENTS.md:25-30,118-156`; current modes at `packages/shared/src/sp-writes.ts` lines 933,1026-1041 | WP-217 coordinates policy, delegated receipt and persistence changes. A key is an explicit authorization source, not a simulated human click. Current policy remains in force until that slice lands. |
| MCP key ownership/input staging are incomplete | `supabase/migrations/20260814120000_mcp_api_keys.sql` lines 35,52; `apps/mcp/src/keys.ts` lines 35-47,114-119,209-238; `apps/mcp/src/http.ts` lines 120-126; SP provenance at `packages/shared/src/sp-writes.ts` lines 232-247,529 | The write enum already exists. Add verified owner/scope propagation, versioned delegation and real proposal source rows; never trust caller-supplied actors or invented apply-row IDs. |
| Audit-after-handler cannot safely wrap a write | `apps/mcp/src/server.ts` lines 155-188 | Transactionally bind audit, exact plan, delegation, idempotency, daily capacity and enqueue; report unknown outcomes truthfully. Check revocation/kill switches again before dispatch. |
| Design scopes overlap or omit required parents | Initial WP-208/209/211 scopes; parent widths in `apps/web/app/recommendations/page.tsx` lines 231 and `apps/web/app/ngrams/page.tsx` lines 126 | Serialize theme changes; WP-209 alone changes shared UI files; add missing parent pages. Centralize HANDOVER/STATUS integration. |
| Table conversion risks lost selection, truncated population claims and late restore races | `apps/web/app/optimizer/campaign-workspace.tsx` lines 90-121; `packages/db/src/queries/recommendations.ts` lines 419,681; `packages/ui/src/views.ts` lines 57; `apps/web/app/grid/grid-client.tsx` lines 399 | Preserve existing selection, declare the initial four workspaces, add backend proposal/completeness handoffs and retain asynchronous restoration safety. Optimizer pagination itself is a client-side slice. |
| Overview confused implementation, policy and evidence | Cron/worker source above; `AGENTS.md:118-121`; `supabase/tests/supabase-platform-shim.sql` lines 38-40; `.github/workflows/ci.yml`; `package.json` | Describe the web credential discrepancy explicitly. Service role bypasses RLS. Local check has five checks; CI does not invoke skill lint. Repository filenames do not prove hosted state; repair multiline inventory discovery. |

## Executed evidence

The actual row parser was called with a synthetic pre-column row and with `claim_token: null`.
The missing-column case threw `claim function returned an invalid claim capability`; SQL null
returned `claim: null`. The current policy functions also confirmed general role enables
background passes and producer-on/lane-off throws. These tests do not prove a hosted claim
transaction or migration rehearsal.

Reproduce the parser/policy assertions from the repository root:

```bash
pnpm exec tsx -e '
import assert from "node:assert/strict";
import { claimedJobFromRaw } from "./packages/db/src/queries/job-wire.ts";
import { resolveWorkerDeploymentPolicy, resolveCreativeSyncPilotPolicy } from "./apps/worker/src/deployment-role.ts";
const row = {
  id: "00000000-0000-4000-8000-000000000001",
  org_id: "00000000-0000-4000-8000-000000000002",
  profile_id: "00000000-0000-4000-8000-000000000003",
  job_type: "entity.sync", payload: {}, attempts: 1, max_attempts: 3,
  dedupe_key: null, claimed_by: "synthetic-worker"
};
assert.throws(() => claimedJobFromRaw(row as never), /invalid claim capability/);
assert.equal(claimedJobFromRaw({...row, claim_token: null} as never).claim, null);
const types = ["creative.sync", "report.request", "report.poll", "report.fetch"] as const;
assert.equal(resolveWorkerDeploymentPolicy(undefined, types).startsBackgroundPasses, true);
assert.throws(() => resolveCreativeSyncPilotPolicy({OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: "1"}), /exclusive Evo report lane/);
console.log("PASS: parser and policy assertions");
'
```

An independent review executed the exact historical deployment-role module, not a restatement
of its logic. Run from the repository root:

```bash
node --import tsx --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const require = createRequire(process.cwd() + '/apps/worker/src/deployment-role.ts');
const source = execFileSync('git', ['show', '397eff8:apps/worker/src/deployment-role.ts'], { encoding: 'utf8' });
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInNewContext(compiled, { exports, require });
const general = exports.resolveWorkerDeploymentPolicy(undefined, exports.EVO_REPORT_LANE_JOB_TYPES);
const lane = exports.resolveWorkerDeploymentPolicy('evo-report-lane', exports.EVO_REPORT_LANE_JOB_TYPES);
assert.equal(general.startsBackgroundPasses, true);
assert.equal(lane.startsBackgroundPasses, false);
assert.throws(() => exports.resolveCreativeSyncPilotPolicy({ OPENSPELL_CREATIVE_SYNC_PRODUCER_READY: '1' }), /exclusive Evo report lane/);
console.log(JSON.stringify({ revision: '397eff8', general, lane, rollbackLaneOnly: 'throws' }));
NODE
```

Observed: exit 0, general background passes true, report-role background passes false, lane-only
rollback throws. The pinned revision's health does not expose a protocol field.

Four selected existing campaign-creation tests passed in two invocations:

```bash
pnpm --filter @wizard-ads/shared exec vitest run src/campaign-creation.test.ts -t 'enforces execution dependencies|represents staged running work|keeps operator, provider'
pnpm --filter @wizard-ads/shared exec vitest run src/campaign-creation.test.ts -t 'joins the exact frozen plan'
```

The second command includes rejection of an ad-group dispatch while its successfully created
campaign remains unobserved (`packages/shared/src/campaign-creation.test.ts` lines 1667-1734).

## Limits and next validation

- Production ledger/deployment/service claims remain dated reported evidence. Refresh them
  before the relevant operational window. This review provides no live-write execution evidence.
- Full prefix upgrade, committed failed-claim recovery and preview lifecycle need the disposable
  database tests assigned to Claude in WP-207/216. Static source and parser calls do not replace
  those tests.
- The source-phase CI conflict is established by the existing exact-string import bans; the
  future source PR does not exist yet. Its two-phase allowance needs tests when implemented.
- Delegated daily-budget races, durable audit admission, revocation and runtime kill-switch
  behavior are requirements for code that does not exist yet, not passed test claims.
- WP-212 still owns full reproducible overview inventories. This audit corrected misleading
  claims and discovery commands; it does not certify every overview count or environment list.

## Repository verification

`pnpm check` passed typecheck and lint, then stopped on an existing core timing assertion:
109.9 ms against a 100 ms limit during concurrent package tests/Rust builds. Its isolated rerun
passed all four tests in that file. The serial retry
reached DB suites but the local Supabase principal cannot lock `pg_catalog.pg_authid` in
`supabase/tests/supabase-platform-shim.sql` line 29. This is a test-bootstrap limitation, not
proof that migration 060000 needs that permission: its role installer explicitly avoids the
catalog lock. Claude's WP-207 rehearsal must use a disposable test principal compatible with
this shim, such as the plain-Postgres CI service, before certifying the migration procedure.

The database retry used a fresh disposable `postgres:17` container bound to loopback, with
both `DATABASE_URL` and `WIZARD_ADS_TEST_DATABASE_URL` pointing only at that container. All 21
non-UI package test tasks passed with CI-style serialization:

```bash
pnpm exec turbo run test --filter=!@wizard-ads/ui --concurrency=1 -- --maxWorkers=1
```

The container was stopped and removed after testing. Existing local Supabase permissions were
not changed. This passes the existing migration suites; the new WP-207 prefix/recovery scenario
still needs implementation and its own evidence.

UI verification used `pnpm --filter @wizard-ads/ui run test`: 14 functional files and 163 tests
passed, plus nine of ten performance tests. The existing high-cardinality option extraction
assertion in `packages/ui/src/pipeline.perf.test.ts` line 158 failed at 149.4 ms against a
125 ms local limit. Its isolated retry failed at 144.6 ms:

```bash
pnpm --filter @wizard-ads/ui exec vitest run src/pipeline.perf.test.ts --maxWorkers=1 -t 'extracts a high-cardinality option set'
```

This is a measured pre-existing local performance failure; this branch changes no UI code.
The overall `pnpm check` is not certified green. No timing assertion, DB privilege or test skip
was changed to make it pass. Typecheck, lint, skill lint, staged diff checks and hygiene passed.
Hygiene scanned 1461 of 1462 tracked files, with one existing exemption. The private denylist
is absent, so client-name checking was skipped; the documented WP-211 scrub is still required.
All 12 handoff brief links and 32 audited source citation paths/line bounds were checked.
Exactly 16 Markdown documents changed; runtime source and active deployment state are unchanged.
