# WP-170 - Auth security rollout

## Outcome

Add reversible account-security features to the Next.js web application without
opening public signup or making an experimental provider API part of the rest of
the application.

Every successful first-factor login passes through `/auth/continue`. A pure
assurance policy decides whether the browser may continue, must verify a TOTP
factor, or must enroll one. Password recovery and TOTP management use server
operations. Passkeys use one browser-only adapter because WebAuthn ceremonies
require the browser and Supabase marks the API experimental.

## Decision and rationale

The caller-facing path comes first:

```text
password / magic link / Google / invitation / passkey
  -> /auth/continue?next=<validated local path>
  -> allow | /auth/mfa/challenge | /settings/account?mfa=enroll | /login

/forgot-password -> fixed PKCE callback -> /recover-password
/settings/account -> reauthorize strongest enrolled factor -> mutate one credential
```

This keeps policy pure and makes provider calls operation-complete. It also
keeps the existing `currentUser` path untouched when enforcement is off. A
broad `AuthService` or authentication kernel was rejected: it would combine
cookies, organisation membership, recovery, WebAuthn, MFA, and redirects in a
single volatile abstraction without giving callers a more useful contract.

The main interfaces are discriminated results rather than thrown provider
objects: `SessionSecurity`, `AssuranceDecision`, `RecoveryRequestResult`,
`TotpOperationResult`, and `BrowserPasskeys`. Unknown assurance fails closed.
Provider error details never cross these boundaries.

## Module map

- `src/auth/config.ts`: validated rollout configuration.
- `src/auth/assurance.ts`: pure requirement and decision tables.
- `src/auth/continuation.ts` and `app/auth/continue`: safe local redirects and
  the one post-first-factor checkpoint.
- `src/auth/recovery.ts` and recovery routes: nondisclosing request and
  operation-complete password replacement.
- `src/auth/totp.ts` and MFA/account surfaces: factor ownership, enrollment,
  challenge, cleanup, removal, and reauthorization.
- `src/auth/passkeys.client.ts`: the only experimental SDK/WebAuthn boundary;
  it is imported only by client components.
- `src/auth/guard.ts`, `src/server/request-context.ts`, Grid, and Amazon OAuth:
  one role-aware assurance decision across every protected boundary;
  account-security has a narrow loop-breaking entry point.

## State transitions

```text
anonymous -> first factor -> aal1
aal1 + no verified TOTP -> allow, or enroll when privileged policy requires aal2
aal1 + verified TOTP -> challenge -> aal2
aal2 -> allow
unknown/provider failure -> unavailable (closed)

recovery idle -> generic sent -> callback exchanged -> password replaced
TOTP absent -> unverified enrollment -> verified -> challenged or removed
passkey absent -> registered -> renamed or removed (experimental, gated)
```

## Boundaries

- Scope is `apps/web` and this brief.
- Invitation acceptance remains the only account-creation path.
- Magic-link sign-in keeps `shouldCreateUser: false` and remains visible even
  when passkey sign-in is enabled.
- Password login, Google, recovery, TOTP enforcement, and passkeys all default
  off. Magic link remains the available invite-only fallback.
- No migration, seed, Amazon request, production configuration, secret, client
  roster, or real account fixture belongs to this package.
- Provider errors are mapped to closed user-facing results. Password recovery
  never reports whether an address has an account.

## Configuration

The web process reads five server-owned rollout controls:

- `WIZARD_ADS_PASSWORD_LOGIN=0|1`
- `WIZARD_ADS_PASSWORD_RECOVERY=0|1`
- `WIZARD_ADS_GOOGLE_LOGIN=0|1`
- `WIZARD_ADS_TOTP_POLICY` accepts `off`, `enrollment-only`,
  `enforce-when-enrolled`, or `require-for-privileged`.
- `WIZARD_ADS_PASSKEYS` accepts `off`, `manage-only`, `enroll`, or `sign-in`.

Missing values select the off state. Invalid values fail configuration parsing
instead of silently selecting a weaker policy.

Passkeys also require Supabase project configuration for the stable production
relying-party id and allowed HTTPS origins. That operator action is not made by
application code.

Google must remain off until the hosted provider has public signup disabled,
the canonical Site URL configured, and invitation acceptance plus Google login
have been live-tested together. Repository-local provider configuration is not
evidence of the hosted setting.

Passkeys must remain off in production until enrollment, sign-in, list, rename,
removal, account recovery, and fallback login pass against the hosted provider.
The server action is a UX preflight for step-up; the browser performs the actual
experimental provider mutation, so application code cannot claim a server-bound
mutation authorization that the provider API does not expose.

## Observability

Production telemetry should count checkpoint decisions by policy, recovery
requests by public result, and TOTP/passkey operations by operation and coarse
outcome. It must not include email, user id, factor id, credential material,
provider error text, or the requested redirect. Alert on unavailable assurance,
challenge failures, and repeated continuation loops. No new telemetry sink is
introduced in this slice; HTTP/provider logs and the tested discriminated
outcomes remain the available signals until an approved sink exists.

## Architecture red-flag screen

- No god service: policy, cookie validation, and each provider operation stay
  separate.
- No provider types leak into pages or guards; the experimental surface has one
  adapter.
- No parallel authentication checkpoint is introduced.
- No flag silently weakens on an invalid value.
- No security state is encoded as unrelated booleans; unions make unavailable,
  challenge, enrollment, and success explicit.
- No factor or passkey is accepted by caller-supplied id alone; the provider's
  current-user list is reconciled first.
- The browser passkey mutation authorization is intentionally narrow and does
  not pretend to be a server-bound WebAuthn mutation. Production remains off
  until provider behavior is verified live.

## Acceptance checks

- Config and assurance decision tables cover every state, including unknown
  assurance and provider failure.
- Protected Server Components, route actors, Grid, and Amazon OAuth all apply
  the same role-aware assurance policy and expose a structured continuation.
- Password, magic-link, Google, invited-user, and passkey first factors converge
  on the same continuation route.
- Recovery request responses do not disclose provider acceptance or account
  existence. Previously issued callbacks remain usable when new requests are
  disabled.
- TOTP enrollment cleans up stale unverified TOTP factors, reconciles every
  cleanup result, verifies a selected factor, and requires the strongest
  assurance already available before account-security mutations.
- Passkey code compiles against an intentionally declared supported Supabase JS
  version and does not enter a server bundle.
- Focused tests, web typecheck, repository tests, lint, and hygiene pass.
- A source assertion proves `auth.admin.createUser` remains confined to
  invitation acceptance and magic-link sign-in still sets
  `shouldCreateUser: false`; local Supabase configuration keeps signup disabled.

## Rollback

Disable new recovery requests while leaving recovery completion available for
already-issued links. Reduce the TOTP policy without deleting provider factors.
Reduce passkeys from `sign-in` to `manage-only` or `off`; magic link remains the
fallback. The Supabase dependency can stay at the tested version. There is no
database rollback.
