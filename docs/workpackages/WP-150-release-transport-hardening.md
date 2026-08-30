# WP-150 — Release transport hardening

## Outcome

Harden the immutable web-candidate preflight without changing product routes,
deployment configuration, authentication state, or any Amazon behavior. The
verifier retains the active organization and profile chosen in the existing
operator browser, then makes GET-only candidate requests through bounded,
authenticated `vercel curl` processes.

## Contract

- The existing immutable candidate hostname policy and exact full-revision gate
  remain authoritative.
- No standalone protection-bypass secret is required or created. The Vercel CLI
  reuses its existing authenticated global context from an unlinked working
  directory; the optional existing `VERCEL_TOKEN` environment context is never
  converted to a process argument.
- The immutable hostname and static route path may enter Vercel arguments. Query
  parameters and the authenticated cookie header enter curl through stdin
  configuration only; none appears in files, diagnostics, or the report.
- Vercel receives a fixed command shape and a minimal environment containing
  only runtime, network, and existing CLI-auth discovery values. Database,
  Amazon, provider, browser, bypass, and debug variables are not inherited.
- Each request is GET-only, has a 30-second curl limit, a 35-second process
  limit, a 64 MiB response ceiling, and a 256 KiB diagnostic ceiling.
- Curl never follows redirects. The verifier may make one second request only
  after validating a same-origin canonical destination with the exact active
  profile and unchanged query parameters. A second redirect fails.
- The current route list and its HTML, application-shell, expected-content,
  login, no-profile, database-gate, and server-error assertions remain intact.
- Failures emit a fixed `OPENSPELL_RELEASE_ERROR:<code>` diagnostic. Dependency
  messages, endpoints, cookies, bypass material, and candidate locations are
  not printed.

## Acceptance checks

- Unit tests accept the root-to-dashboard redirect and reject cross-origin,
  wrong-profile, path-changing, query-changing, encoded, fragmented, and cyclic
  redirects while counting the requests made.
- Transport tests prove the no-bypass-secret path, static Vercel arguments,
  stdin-only query and cookie inputs, minimal child environment, response
  bounding, and fixed diagnostics.
- A launcher subprocess test proves Node/Playwright debug loaders are removed
  before pnpm starts and a CDP failure cannot disclose its inputs.
- Focused tests and the full repository `pnpm check` pass.
- No deployment, promotion, migration, seed, database connection, Amazon API
  call, or browser-state mutation is performed by this package.
