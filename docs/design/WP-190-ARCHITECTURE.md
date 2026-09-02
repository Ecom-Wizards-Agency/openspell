# WP-190 architecture: authenticated guard process isolation

## Decision summary

Split the broad authenticated guard file into two explicitly owned Playwright suites:

- `auth-guards-anonymous` owns the anonymous root-frame proof and the exact 25-route redirect
  sweep;
- `auth-guards-signed-in` owns the signed-in root-frame proof, the same 25-route acceptance sweep,
  and the authenticated not-found proof.

Each suite gets its own Playwright invocation, disposable database, fake Amazon server, browser
lifecycle and bounded Next development process. The existing `auth` suite keeps only Dashboard and
ordinary Grid tests. The complete gate remains serial, uses one Playwright worker per config, keeps
retries at zero, keeps the four-gigabyte V8 limit, and runs the same 69 tests.

One declarative suite registry owns order and dispatch. A test-only cleanup stack makes partial
setup and normal teardown best-effort across every acquired resource, so a failed fresh process
cannot leave the fixed database or ports poisoned for the next suite.

This is test-harness hardening only. It changes no application route, authentication policy,
database migration, runtime configuration, deployment or production state.

## Grounded problem

WP-189 exact-head CI passed all 69 browser tests. Its identical merge tree then reached 3,937 MB of
live V8 heap in the broad `auth` Next process after compiling both 25-route guard sweeps. Next
aborted at its explicit 4 GB ceiling, and the following authenticated 404 test received
`ERR_EMPTY_RESPONSE`. A clean full Playwright-job rerun passed all 69 tests with retries disabled.

The failure is not evidence of a WP-189 product regression: WP-189 changed worker and documentation
files only, and implementation and merge commits have the same tree. It is evidence that the auth
shard has no reliable memory margin. Earlier route, role, member, OAuth, Grid, profile-context and
optimization-group partitions use fresh processes for the same reason. The remaining two full
guard sweeps must no longer retain their compiled route graphs in one server.

## Hard boundaries

- Keep `next dev --webpack`, `NODE_ENV=development` and the real test-session cookie path. The
  production header bridge cannot express an anonymous visitor and is not an alternative.
- Keep `WIZARD_ADS_E2E_AUTH=1` and its production refusal.
- Keep `--max-old-space-size=4096` and disabled development-memory restarts. Do not increase the
  heap or restart one shared server between phases.
- Keep `fullyParallel: false`, `workers: 1`, `retries: 0`, the existing timeouts and the existing
  trace/screenshot behavior.
- Keep the outer runner strictly serial. Authenticated suites share fixed ports, a fixed database
  name and one state-file path, so overlap would race or destructively replace fixtures.
- Keep the exact 25 unique guarded routes and every current redirect, canonical-profile, heading,
  not-found and counted-output assertion in one per-route discriminated manifest.
- Keep the runner's policy that every selected suite runs even after an earlier failure and the
  final nonzero result is preserved.
- A partial setup or teardown failure must attempt cleanup of every acquired resource before its
  error propagates; cleanup order remains Next, mock, database.
- Do not add a skip, retry, automatic rerun, timeout increase, `--pass-with-no-tests`, application
  change, migration, deployment setting or production action.

## Architecture candidates

### Candidate A: one extra config selected by test-title grep

Run the anonymous sweep in a new config using an anchored title regex and grep-invert it from the
existing auth config. This is the smallest diff and a zero-test config normally fails closed.

Rejected because test ownership remains encoded in prose. Renaming a test, composing a forwarded
`--grep`, or changing Playwright selection precedence can change ownership without a file-level
boundary. It also leaves unrelated Dashboard and Grid graphs in one guard process.

### Candidate B: two dedicated guard specs and configs

Move the anonymous and signed-in assertions into separate spec files backed by one shared route
manifest. Give each file a dedicated config and runner suite; restrict the existing auth config to
Dashboard and Grid.

Selected. File selection is explicit, forwarded filters cannot silently move a test to another
process, both sweeps receive fresh servers, and the union can be counted exactly.

### Candidate C: restart Next inside one authenticated setup

Reuse one database and Playwright invocation but kill and restart Next between sweeps.

Rejected. That creates an order-dependent multi-phase fixture, couples session and in-process mock
state to a restart protocol, and makes teardown ownership ambiguous.

### Candidate D: increase heap, add retries or rerun CI automatically

Rejected. Those choices conceal retained route graphs and would make the gate less truthful.

## Selected ownership model

### Shared route contract

One test-only module owns the route and every conditional signed-in expectation together:

```ts
type SignedInExpectation =
  | { kind: 'requested'; canonicalProfile?: true; heading?: string }
  | {
      kind: 'redirect';
      pathname: string;
      hash: string;
      canonicalProfile: true;
      artifact: string;
      heading: string;
    };

export const GUARDED_ROUTES = [
  { path: '/dashboard', signedIn: { kind: 'requested', canonicalProfile: true, heading: 'Dashboard' } },
  // the other 24 exact current entries
] as const satisfies readonly { path: string; signedIn: SignedInExpectation }[];
```

Both guard specs import this one manifest. Neither may copy, filter or locally widen it. Unit
goldens prove 25 unique paths, the exact seven canonical-profile paths, the exact one complete
redirect object, the exact seven path-to-heading pairs, and no orphan expectation. The anonymous
assertion still compares 25 landed paths with 25 `/login` values. The signed-in assertion still
compares all 25 landed paths with the requested path or the one documented intentional redirect.

### Process partitions

Every authenticated config inherits the same global setup and teardown. A test-only cleanup stack
registers each resource immediately after acquisition. For each invocation:

1. reclaim the fixed disposable database, register its idempotent drop immediately before the new
   `CREATE DATABASE`, then create and migrate it so even an unknown create outcome is owned;
2. apply the real migrations and synthetic fixture;
3. start the fake Amazon server and register its close;
4. spawn one Next development process, synchronously observe child error/exit, register its stop,
   then await readiness through a cancellable poll under the unchanged 4 GB cap;
5. run one Playwright worker with zero retries;
6. attempt Next stop, mock close and database drop in reverse acquisition order even if an earlier
   cleanup rejects.

If setup fails, it cleans every acquired resource before propagating the original error; cleanup
failures join it in an `AggregateError`. Normal teardown uses the same idempotent stack and likewise
attempts every cleanup before propagating one or more failures. The outer runner waits for teardown
before starting the next suite. Distinct output directories, report directories and project names
prevent artifact overwrite.

### Exact suite inventory

The new serial order and discovered test counts are:

| Suite | Tests |
|---|---:|
| `tags-goto` | 32 |
| `grid-performance` | 1 |
| `optimization-groups` | 1 |
| `profile-context` | 3 |
| `auth-guards-anonymous` | 2 |
| `auth-guards-signed-in` | 3 |
| `auth` | 4 |
| `auth-members` | 5 |
| `auth-oauth` | 7 |
| `auth-roles` | 8 |
| `route-acceptance` | 3 |
| **Total** | **69** |

The two old route sweeps remain 50 route visits over the same 25-route input. Process count rises
from nine to eleven; assertion count does not change.

### Declarative suite registry

Replace the nested conditional whose final branch silently falls through to route acceptance with
one ordered registry. Each entry owns its suite name, execution kind, exact config, project,
expected spec files and expected test count. `E2E_SUITES`, argument parsing and runtime dispatch are
derived from this registry rather than maintained as parallel lists.

```ts
export const E2E_SUITE_DEFINITIONS = [
  {
    name: 'tags-goto',
    kind: 'production-bridge',
    config: 'playwright.tags-goto.config.ts',
    project: 'tags-goto',
    expectedSpecFiles: [/* exact six files */],
    expectedTests: 32,
  },
  // all ten authenticated-dev entries in canonical serial order
] as const satisfies readonly E2ESuiteDefinition[];
```

The production-bridge entry dispatches to its environment-owning builder; authenticated entries
dispatch through the one generic authenticated runner using the entry's config. Unit tests prove
names, configs and projects are unique, the exact name-to-config-to-project-to-spec mapping matches
the golden registry, spec ownership has no overlap, and expected counts total 69. The previously
inherited `auth` project label on the isolated Grid-performance config becomes `grid-performance`
so project ownership is truthful. Named-runner
`--list` output is normalized by test title and compared with the 69-case pre-change inventory.
This catches a valid-but-wrong registry entry, duplicate config or omitted suite.

The loop retains its existing behavior:

```ts
let worst = 0;
for (const definition of selectedDefinitions) {
  const code = await runSuite(definition, playwrightArgs);
  if (code !== 0) worst = code;
}
return worst;
```

## Failure semantics

- A route mismatch fails its owning suite without a retry.
- Setup, server startup or teardown failure cleans every acquired resource, cancels and settles any
  losing readiness poll, and fails that suite; the next suite starts only after cleanup settles.
- An earlier failure does not suppress later suites, so one run reports the whole process matrix.
  A suite that throws before Playwright returns an exit code is logged, recorded as nonzero, and
  likewise cannot suppress later suites.
- A renamed or omitted spec is detected by named-runner `--list` inventory and the conserved
  69-test full gate; no config is allowed to pass with zero tests.
- First-attempt exact-head and exact-main Playwright success is required to close the heap-margin
  issue. A job rerun does not prove this package's objective.

## Acceptance matrix

1. Each named `e2e/run.ts` or package selector forwards `--list` through the environment-owning
   runner and reports exact counts `32,1,1,3,2,3,4,5,7,8,3`, 69 test cases total. The five guard
   titles and assertions remain unchanged; their file and Playwright-project identities change
   intentionally with process ownership. Grid-performance keeps its one test and config but gains
   its truthful project label, so that Playwright identity also changes intentionally.
2. Registry tests prove the exact unique suite-to-config-to-project-to-spec mapping, disjoint spec
   ownership, 69 expected cases and derivation of parser order plus dispatch from that registry.
3. The two guard configs select only their owned spec; the primary auth config selects exactly four
   Dashboard/Grid tests. Normalized pre/post discovery preserves all 69 logical test titles.
4. Manifest goldens prove 25 unique paths, exact canonical/redirect/heading subsets and no orphan
   expectation. Anonymous and signed-in sweeps each account for all 25 inputs.
5. Cleanup-stack and global-setup orchestration tests inject a failure at every acquisition,
   readiness and cleanup cut; they prove unknown-create ownership, readiness cancellation, reverse
   order, idempotence, original-error preservation and aggregated cleanup failures.
6. Both guard suites pass alone and consecutively in both orders against disposable PostgreSQL.
   Forced Next-readiness and teardown failures leave no listener, mock, database or state poison.
7. The complete runner executes all eleven suites in order, reports all 69 tests, and preserves a
   nonzero result from any failed suite.
8. Resolved configs retain one worker, zero retries, serial mode, the same setup/teardown and base
   URL, no Playwright `webServer`, and distinct artifact paths.
9. Both new direct selectors preserve forwarded `--list` and `--grep` arguments without selecting a
   test owned by the other guard process.
10. Web typecheck, unit tests, lint, hygiene, production build and the full serial browser gate pass.
11. No application, migration, shared contract, worker, provider, deployment or production file
   changes.
12. Exact pushed head and exact merged main pass both hosted jobs on their first attempts.

## Files and ownership

WP-190 may change only the web test harness, CI comments and its own documentation:

- `apps/web/e2e/guards.spec.ts`: replaced by the two owned guard specs;
- `apps/web/e2e/guards-anonymous.spec.ts`: anonymous frame and redirect sweep;
- `apps/web/e2e/guards-signed-in.spec.ts`: signed-in frame, route sweep and 404;
- `apps/web/src/e2e-guard-routes.ts` and `.test.ts`: one discriminated route/expectation manifest
  plus exact subset goldens;
- `apps/web/playwright.auth.config.ts`: Dashboard/Grid selection only;
- `apps/web/playwright.grid-performance.config.ts`: truthful `grid-performance` project label;
- `apps/web/playwright.auth-guards-anonymous.config.ts`: fresh anonymous guard process;
- `apps/web/playwright.auth-guards-signed-in.config.ts`: fresh signed-in guard process;
- `apps/web/e2e/run.ts`: eleven-suite documentation and registry-derived dispatch;
- `apps/web/src/e2e-suite-registry.ts` and `.test.ts`: one exact ordered ownership registry;
- `apps/web/src/e2e-args.ts` and `.test.ts`: registry-derived order and selectors;
- `apps/web/package.json`: focused scripts for both new suites;
- `apps/web/src/e2e-resource-cleanup.ts` and `.test.ts`: idempotent reverse-order best-effort cleanup;
- `apps/web/e2e/global-setup.ts`: staged resource acquisition, setup-failure cleanup and shared
  best-effort teardown;
- `apps/web/next.config.ts` and `.github/workflows/ci.yml`: comments corrected to the partitioned
  process model;
- `docs/design/WP-190-ARCHITECTURE.md` and
  `docs/workpackages/WP-190-ci-auth-guard-process-isolation.md`: architecture and implementation
  contract.

No other file is in scope. Handover and status remain unchanged until implementation merges and
exact-main CI passes.

## Activation statement

WP-190 cannot activate, deploy or expose a feature. It only makes the existing browser gate
reliable enough to protect the next correctness slice. The token-fenced Sponsored Products outbox
successor remains separate and every Amazon write gate stays closed.
