# WP-167 — Web function region colocation

## Outcome

Place OpenSpell's Vercel Functions in Frankfurt, beside the hosted web data
source, without changing authentication, tenant fencing, database pooling,
queries, response limits, or product behavior. Static assets remain globally
distributed by Vercel.

## Evidence before the change

The deployed application had no repository-owned function-region setting.
Authenticated server responses identified Washington, D.C. (`iad1`) as their
execution region, while the authenticated database project settings identified
Frankfurt as the data region. The complete Grid route separately measured
material time in both session verification and first database acquisition.

Vercel's current documentation says new Node.js Functions default to `iad1`,
supports a project-level `regions` array in `vercel.json`, and recommends running
Functions close to their data source to reduce response latency. `fra1` is the
documented Frankfurt region identifier.

This evidence justifies a bounded location A/B test. It does not justify
weakening verified claims, opening a database before identity, increasing the
pool, caching actor-scoped results across requests, or changing Grid completeness.

## Change

- `apps/web/vercel.json` declares exactly one Function region: `fra1`.
- The existing five-minute synchronization trigger is unchanged.
- A focused test protects both facts so a later configuration edit cannot move
  server work or silently remove the scheduler.

## Release gate

Before the public alias moves, an immutable candidate must prove:

- the exact full Git revision through `/api/healthz`;
- the authenticated application shell and expected content on all guarded
  release routes;
- the active profile remains selected through the candidate transport;
- the Grid returns every row, reconciles `rowCount` to the returned array, and
  reports `truncated=false`;
- the closed `Server-Timing` spans contain no identifiers or arbitrary headers;
- authenticated server responses execute in `fra1`;
- repeated candidate timings are compared with the unchanged production
  revision before any latency improvement is claimed.

If the candidate changes data, authorization, completeness, or error behavior,
or does not improve the database-bound paths, do not promote it. A region change
is reversible by promoting the last verified deployment; it needs no database
rollback.

## Hosted A/B evidence

Two staged production deployments used the same production configuration
without moving the public custom domain. The control was the exact parent
revision with Vercel's default `iad1` placement. The treatment was the exact
WP-167 revision with `fra1`. Response headers confirmed both runtime regions.

Both candidates passed the exact-revision gate twice, rendered all eleven
authenticated routes, returned identical response-byte counts route by route,
and reconciled the complete Grid result to its declared count with no
truncation. The real row count remains runtime evidence and is not copied into
this public brief.

| Boundary | `iad1` control, two runs | `fra1` treatment, two runs |
|---|---:|---:|
| Dashboard document | 4.857–5.447 s | 2.766–3.266 s |
| Grid document | 4.254–5.324 s | 2.815–3.156 s |
| Complete Grid request wall time | 5.272–5.807 s | 3.295–3.864 s |
| Grid server total | 1.897–2.472 s | 0.573–0.644 s |
| Grid actor verification | 0.325–0.495 s | 0.090–0.218 s |
| Grid role and connection receipt | 0.657–0.675 s | 0.038–0.047 s |
| Grid row aggregation | 0.750–1.130 s | 0.310–0.377 s |

The treatment improved every compared boundary while preserving the exact
artifact and result assertions. Colocation is therefore accepted; authentication
and pooling changes remain separate hypotheses rather than being bundled into
this package.

## Verification

Run the focused configuration test, web typecheck, full repository check,
production build, hosted CI, and the immutable-candidate verifier. After
promotion, repeat the authenticated route sweep against the public alias and
record the exact live revision and execution region.

No Amazon request, product write, migration, seed, credential, database row, or
real account fixture is introduced.
