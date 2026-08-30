# WP-134 — Web database session lifecycle

## Problem

Vercel packages dynamic routes independently. A warm route bundle retained a
three-connection postgres.js pool after its response, so a serial QA sweep across
enough routes could exhaust a small session-mode Supabase pool even though the
browser sent only one request at a time.

## Scope

- Keep one lazy database handle per warm web runtime.
- Limit that handle to one physical connection.
- Configure a one-second postgres.js idle timeout so a warm JavaScript client
  does not retain a session-pool connection between requests.
- Keep database lifecycle outside Next.js `after()` callbacks. Cancelled and
  redirected Server Component renders still need their original cookie context.

Request-scoped API clients already close in `finally` blocks and are unchanged.
Worker pool sizes and cron concurrency are outside this package.

## Acceptance evidence

- Repeated module loads reuse one handle and one physical-connection allowance.
- The idle-timeout option reaches postgres.js and explicit close reaches
  `sql.end()`.
- When a local test Postgres is available, the real driver test observes one
  session after a query and zero after the configured idle interval.
- Typecheck, lint, tests, hygiene, and the production web build pass.

The release candidate must still pass the authenticated serial multi-route sweep
before production promotion. Code-level lifecycle evidence is necessary, but it
does not prove the behavior of a deployed serverless runtime or its configured
database pool.
