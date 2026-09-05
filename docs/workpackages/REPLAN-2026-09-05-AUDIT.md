# Re-plan audit and corrections, 2026-09-05

Original reviewed source: `560d5e2`. Original handoff commit: `1e62a92`. The audited handoff is
`REPLAN-2026-09-05.md`. Documentation review used `wp-207-replan-audit`; authorized source work
now continues on `wp-214-sp-write-source`. This document records meaningful implementation
changes as well as the original audit.

The initial review changed documentation and package scope. Subsequent source work is described
below. Tests use disposable local PostgreSQL 17 and synthetic provider facts. No hosted database,
deployment, credential store or Amazon account was accessed.

## Operator direction incorporated

- Claude Fable 5.1 owns frontend design, including the new write-preview client components.
- The operator expects to work with Claude on D1/WP-207 and D2/WP-216. GPT provides the
  corrected handoff and does not begin those implementations.
- Both write entrypoints are required: changes submitted through the OpenSpell UI and
  programmatic changes through its authenticated MCP connection. WP-214 proves UI-driven
  Amazon writes first; WP-217 completes MCP discovery, preview, apply and status against the
  same backend. The MCP path must work without browser cookies or a per-change UI action
  within its operator-issued delegation. A separate REST service is not a prerequisite.
  HTTP tests cover the UI backend and the actual MCP connection.
- Goal-mode building is now authorized. Every MCP change and linked reversion must be recorded
  and visible in Time Machine; add execution-ledger projection and real reversion support.
- Source work, testing and review can proceed autonomously. A tested operational window can
  receive one scoped authorization for its exact targets and restoration steps; attendance and
  per-command confirmations are not technical requirements. Live bounds are not invented here.
- Keep this audit current whenever a meaningful implementation or verification result changes.
- Keep the main replan's current Claude handoff aligned with this audit, including committed
  versus in-progress work, integration contracts, ownership and additional migration dependencies.

## Implementation progress, 2026-09-05

### Confirmed supervisor parking and scope, 2026-09-05

The operator explicitly decided to park WP-201–205. No work on that program was performed
by this build. [PR #135](https://github.com/Ecom-Wizards-Agency/openspell/pull/135) was still
open when checked and is now closed without merging. The branch remains at `6f86ffd` and
its worktree is retained, including its existing uncommitted `ci.yml` and `HANDOVER.md`
changes. No deletion, reset or rebase was performed. WP-202–205 are not being started.

Remote main and merged [PR #136](https://github.com/Ecom-Wizards-Agency/openspell/pull/136)
were verified at `fc29fb9`. The claim that this merge commit is already an ancestor of the
implementation branch is technically incorrect: their common ancestor is the brief commit
`1e62a92`, which the implementation branch does contain. The audited documents remain on
`wp-214-sp-write-source`; no history rewrite is needed to preserve their work.

The supervisor tradeoff supports parking, with these evidence corrections:

- `230` is the workflow timeout, not measured cost per push. The latest four successful
  trusted-kernel runs lasted roughly 2–2.5 minutes; the latest was
  [run 33971635117](https://github.com/Ecom-Wizards-Agency/openspell/actions/runs/33971635117).
  On checked main, it runs after successful CI for a main push. Claude owns changing this
  workflow in WP-207.
- The four retained tool packages contain 52,116 tracked lines including tests, fixtures
  and documentation. PR #135 adds 41,056 lines and removes 127 across 48 files. These counts
  establish substantial scope; they do not establish a remaining duration of weeks.
- WP-201's source brief explicitly provides an offline, synthetic preparation proof with
  no apply capability or authorized live target. Isolation and formal recovery are design
  benefits, not proof of a deployed production supervisor or elimination of human error.
- Availability of the required narrowly scoped credentials remains unverified here.
  The supervisor would still require a rehearsed, authorized operational window.
- Nine refers to five previously reported unapplied merged migrations plus four local
  WP-214 source migrations. Hosted state was not freshly queried. The latter require a
  second window after WP-214 source review/merge and are not part of WP-207's five-file scope.

Claude's active branches/worktrees were inspected. This build will not edit WP-207, WP-216,
their protected program documents/workflow, or the WP-208/WP-211 frontend scopes. All four
new WP-214 migrations were checked for the five-second lock timeout and shared advisory DDL
lock; their exact identities and compatibility considerations are now in the WP-214 brief.
The second window must precede deployment of a web revision containing native Time Machine:
its read queries require the new evidence tables even when write execution is disabled.

### Source progress

| Change | Verified source and behavior | State |
|---|---|---|
| Shared application and immutable source contracts | `packages/shared/src/sp-write-application.ts` and `sp-write-preview-evidence.ts`; exact operation identity includes execution and plan IDs, and frozen evidence retains original export bytes and strategy/group snapshot text. | Committed before dependent implementation. |
| Immutable previews | `5aa18d8`; `packages/db/src/queries/sp-write-plan-builder.ts` and migration `20260905000000_sp_write_preview_evidence.sql`. Reconstructs the actual export digest, reconciles every source row, preserves exact decimals and timestamp microseconds, and atomically stores plan and policy/provenance evidence. | Local tests prove tenant isolation, immutable replay, false-hash/source/policy refusal, rollback on evidence-storage failure and parent-first locks during concurrent run deletion. |
| Approval, status and inverse operations | `25e771e`; `sp-write-approval.ts`, `sp-write-operation-read.ts`, `sp-write-inverse-preview.ts` and migration `20260905010000_sp_write_preview_approval.sql`. Direct authenticated approval checks frozen source/current scope, binds retries to the original actor/request, and prevents another confirmation from admitting the same plan again. | Synthetic forward and inverse each reach recorded provider result and observation through the real ledger. Original/inverse operation links are returned in both directions. Lost approval/enqueue responses and enqueue failure preserve a recoverable operation identity. |
| Verified reversion after an ambiguous response | The inverse builder accepts `observed_after_ambiguous` only when every requested value was subsequently observed, matching the existing shared dispatch contract. | Regression passed. Partial or unresolved observations remain ineligible; current bid/profile/connection changes refuse approval. |
| UI HTTP backend | `apps/web/app/api/sp-writes/{preview,approve,inverse-preview,status}/route.ts` and `apps/web/src/writes/http.ts`. Uses the existing session/assurance gate, owner/admin capability, fixed-origin JSON POSTs, bounded bodies, strict shared inputs, sanitized error codes and uncached responses. | Local HTTP tests pass preview→approval→status→inverse using the real request database, with no MCP process. Client presentation remains with Claude. |
| Database client compatibility | JSON text parameters in preview persistence, inverse reads and the existing staging facade now use `::text::jsonb`. Plain request connections otherwise encode serialized proof arrays twice; Drizzle-backed tests did not expose this. | The real HTTP request-database test caught the mismatch and passes after the fix. |
| Older database and lost-response safety | Migration `20260905020000_sp_write_application_entry.sql` adds `app.approve_sp_write_preview_v1`. Both initial approval and recovery use that versioned entry with the same immutable confirmation identity. | Review reproduced an unsafe fallback when a connection loss masked the missing-function error. The table-based recovery was removed. PostgreSQL regressions now prove zero enqueue both for an absent entry and a masked error, even with a matching existing receipt. |
| Inert worker orchestration | `apps/worker/src/sp-write-outbox/{artifacts,providers,loop}.ts` and explicit `@wizard-ads/db/sp-write-worker` reads. Resolves credentials before claim, checks current dispatch gates before provider access, admits attempts only with a fresh reservation ticket, and keeps reconciliation available when dispatch closes. | **13 real-ledger/fake-HTTP tests passed**, including recovery after both real deadlines, durable recovery with unavailable credentials, and later observation after the real delivery backoff. Mirror persistence is a required callback and is not implemented by this slice; no entrypoint registration. |
| Partial refusal and large batches | The ledger may refuse only stale positions. Adapter compilation now accepts a unique selection of unchanged actions from the verified full plan; the worker selects unresolved actions from ledger evidence and preserves the original plan fingerprint. | Mixed-batch and 101-row probes passed: one stale row remains untouched while the valid row completes; 101 accepted and observed rows reconcile across exactly two provider calls. The larger probe exposed different collation between plan ordering and predispatch evidence; provider calls now use the evidence contract's exact entity/action ordering. |
| Mirror concurrency finding | The original ordinary-sync path captured its persistence timestamp after provider listing and performed unconditional mirror upserts. An older listing could overwrite a newer native bid observation. | Addressed by the committed optional keyword-mirror capability and race tests below. Activation must configure it on every ordinary entity-sync owner before enabling native writes. |
| Ordinary sync merge contract | Shared `KeywordMirrorMergeRequest` validates unique keywords within one tenant/profile/product and records the database read-start time. Counts include every input, stale bid/tombstone and actual diff. | Five focused shared tests and shared typecheck passed before dependent implementation. |
| Mirror contracts | `packages/shared/src/sp-write-mirror.ts` defines separate promotion/current/superseded/missing receipts, exact decimal and bigint transport, attribution of actual diffs, and reconciled ordinary-sync counts. | All **107 shared tests** passed, plus shared typecheck and targeted lint. Dependent persistence is implemented in the following slice. |
| Native mirror persistence and inert composition | Migration `20260905030000_sp_write_mirror_observations.sql`, `packages/db/src/queries/sp-write-mirror.ts` and `apps/worker/src/sp-write-outbox/composition.ts`. Atomically records an observation receipt, updates the keyword bid when current evidence permits it, and links the exact entity-change ID. Conflicting observations retain separate attribution. | Local tests prove concurrent replay creates one diff, receipt-storage failure rolls back the bid/diff together, and a forward/inverse pair creates two distinct diffs and restores the starting bid. Current-schema parity, RLS, immutability and worker-only RPC permissions passed alongside 53 persistence/blast checks (55 tests total). Time Machine projection and ordinary sync integration are recorded below. |
| Ordinary keyword-sync fencing | `queries/keyword-mirror.ts` captures database time before provider listing, serializes mirror promotion with native observations, and atomically writes actual keyword diffs. The optional worker-store capability counts stale bids and tombstones, preserves newer full-entity evidence, and passes counts into the durable sync-job result. | Four PostgreSQL tests passed for stale values, tombstones/resurrection, precision/scope refusal and rollback on lost diff rows. Two real-worker tests passed for a concurrent native observation and for a write that completes during an ordinary listing. Worker typecheck and targeted lint passed. The capability remains unconfigured in runtime entrypoints. The broader regressions passed **122 worker tests in three files** and **76 DB tests in four files**, including the existing ordinary-sync cases and persistence boundaries. |
| Mirror status contract | `SpWriteOperationDetail` now requires separate mirror counts, including observations still awaiting a receipt. The observation total must match the verified provider ledger. | Eleven shared tests and shared typecheck passed before the status-query implementation. The query now verifies receipts only for observations in the ledger snapshot. Three worker tests, 12 DB tests and four HTTP tests passed; DB/web typechecks and targeted lint passed. The HTTP fixture truthfully reports one pending mirror receipt despite its synthetic direct mirror edit. |
| Native Time Machine read plan | The application architecture now declares the exact projection and server wiring scope. Ordering uses immutable approval time and preserves timestamp microseconds; legacy/native candidates share one repeatable-read snapshot. Only exact provenance or attributed mirror IDs suppress duplicate entries. | The shared `time-machine-writes` contract is now defined, with exact cursors and actor/action/observation/inverse binding. Fourteen focused shared tests, shared typecheck and targeted lint passed. The feed now merges legacy and native entries within one read snapshot and returns exact original/inverse metadata. Eleven existing DB timeline tests and four real-worker history tests passed, including one-row pagination, stable ordering during execution, exact diff suppression, a refused inverse, and preservation of a conflict observation after legacy linking. Server labels/navigation/cursor wiring and all 10 production-build browser tests have passed. Independent review corrections and their regression evidence are recorded below. Conflict observations must remain visible even if a legacy export linker later attaches a batch; the MCP actor is added only with WP-217 delegated receipts. |

The native Time Machine slice is committed at `d74c5de`.

The recommendation population handoff now has a shared contract and declared file scope in
the application architecture. Exact loaded/total/limit counts must reconcile with the
truncation flag. Two focused contract tests and shared typecheck passed before dependent
implementation. The additive `listRecommendationWindow` DB loader now returns exact metadata
and rows from one SQL statement using `count(*) over()` before the 20,000-row cap. It reconciles
safe counts and unique row IDs; the legacy array loader retains its interface. Export download
now refuses a truncated proposal population instead of losing workbook create rows.
Five DB tests passed, including a counted 20,001-row export fixture, scoped/filtered/empty
populations and existing export drift checks; 16 web route regressions passed. DB/web
typechecks and targeted lint passed. The first new fixture used a nonexistent `completed`
run status; it was corrected to the schema's `succeeded` value before these passing runs.
Claude-owned client files are unchanged. Proposal revision design is the next backend slice.

Population implementation is committed at `4bd9c36`. Its final hygiene invocation **failed**:
the private denylist became available and exposed 15 existing matches in the three documents
reserved for Claude's WP-211 scrub. The earlier absence/skipping notes below describe earlier
runs only. No new population source file was reported. These protected documents were not
edited here; the current branch's hygiene gate remains failing until the scrub is integrated.
The local decision trail's initial population checkpoint incorrectly said staged hygiene
passed; a subsequent correction records the nonzero result and existing-document findings.

Proposal revision design is now grounded and synthesized from three independent candidates in
[the declared design](../design/WP-214-PROPOSAL-REVISIONS.md). It preserves original recommendation
and run identities, appends immutable revisions and uses exact content references for review
and export. Replacement proposal rows would conflict with existing run custody. The Python
export validator skips string-valued money, so the chosen bounded numeric export boundary must
prove an exact decimal JSON round trip. Four representative serializer boundaries passed a
local probe; the edit/export lifecycle is not yet implemented. One additional source migration
is planned beyond the four committed WP-214 migrations, outside Claude's original window.

The main replan now contains a current Claude handoff, including the locally verified
native-history slice. It documents the four UI HTTP
contracts, separate provider/mirror states, exact history links, frontend ownership and the
four additional migration dependencies. It makes no claim that MCP or production activation
is finished. Native-history server verification has passed five web helper tests, web/worker
typechecks and targeted lint; 64 DB regression tests also passed.

Rendered-history verification passed **all 10 Time Machine browser tests** against a
production Next build and the disposable database. The new fixture records synthetic forward
and inverse results through the real ledger and native mirror RPC; the browser follows both
operation links and verifies their exact values and observed states. The legacy export path,
cursor handling, filters, bounded response and tenant isolation still pass. The captured page
was visually inspected. This does not exercise Amazon or the unbuilt confirmation client.
The fixture now uses Node assertions so both Vitest and the browser runner can use it; its
older direct synthetic mirror mode remains explicitly distinct from native reconciliation.
The affected existing callers passed **63 DB tests and eight HTTP/helper tests**. A cursor
fixture was corrected to use an actual bigint change ID, and export-panel copy now describes
that export's effect instead of claiming the whole platform cannot write to Amazon.

Independent query review reproduced a history-loss bug: legacy linking could hide an ordinary
sync event by attaching it to a native source batch, without a native mirror receipt. The
committed regression failed with four visible rows instead of five before the query fix.
Native source batches now preserve such sync evidence; only the exact write-attributed receipt
suppresses its diff. **All 12 timeline DB tests passed** afterward. A smaller blank-field
normalization inconsistency was also corrected and verified in the real-worker history test.
The reviewer additionally verified tenant/profile isolation and seven-input/seven-output
one-row pagination with distinct microsecond timestamps. Review source and reproduction
remain in the gitignored decision-trail evidence.

Latest complete database verification: **478 tests in 48 files passed** with `--maxWorkers=1`.
After HTTP integration and JSON transport fixes, the affected database suites also passed
**78 tests**, and HTTP/role/assurance suites passed **15 tests**. Web and DB typechecks and
targeted lint passed.
The later worker slice passed **13 integration tests** in 98 seconds, **335 Ads API tests**
(including 64 adapter/codec tests), and **53 persistence/blast tests**. Worker typecheck and targeted lint passed. The recovery test
uses real database deadlines and delivery backoff; it does not alter immutable timestamps.
With real mirror persistence connected, all **16 worker integration tests** passed in 100 seconds.
DB/worker typechecks, targeted lint and hygiene also passed for this slice.
These are local source checks, not hosted or live Amazon proof. The WP-188 raw-plan facade suite
still runs against its preceding admission contract; new application/HTTP suites exercise current
migrations and source-backed admission. No lifecycle or custody assertion was removed.

Remaining: Claude's native preview/confirmation client, delegated MCP policy/contracts/persistence/transport, proposal revision
and completeness handoff, immutable release/activation artifacts, and scoped live proof. The
current history screen is locally tested, not a claim that MCP or the new confirmation client
is finished. Worker registration and production write enablement have not occurred.

The four new WP-214 migrations are additional source dependencies. They are not silently added
to Claude's original D1 operational window. Deployment must account for them before exposing the
new write flow; hosted migration state has not been inspected. The version-specific entrypoint
refuses admission when its database implementation is absent.

The latest parallel DB run passed 477 of 478 tests; the existing recommendation-preview DDL
lock test reported a division-by-zero error. That test passed in an isolated retry alongside the
new approval-entry regressions (12 tests total). No recommendation migration/test was edited.
The subsequent complete serial DB run passed all 478 tests. The parallel-run failure was not
reproduced in that run; its cause is not established. These results do not certify parallel CI.

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
- Source-phase assertions now admit only the declared HTTP application consumers and local HTTP
  fixture. Only the declared inert provider adapter/loop modules may execute in synthetic tests; entrypoint registration remains forbidden by those checks. The source
  branch is local; PR/CI and activation evidence remain outstanding.
- Delegated daily-budget races, durable audit admission, revocation and runtime kill-switch
  behavior are requirements for code that does not exist yet, not passed test claims.
- WP-212 still owns full reproducible overview inventories. This audit corrected misleading
  claims and discovery commands; it does not certify every overview count or environment list.

## Initial audit repository verification

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
The initial audit changed 16 Markdown documents. A subsequent four-document clarification
made the MCP submission requirement and connection-level acceptance explicit. That clarification
changed no runtime source or deployment state. Later implementation is recorded in the progress
section above; it does not claim deployed tools.
