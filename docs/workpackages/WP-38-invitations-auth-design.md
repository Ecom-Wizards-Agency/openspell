# WP-38 design rationale

## Problem

Add an invite-only account path without weakening the existing no-signup policy. The
web tier uses a service-role Postgres connection for application data, Supabase's anon
client for cookie sessions, and now needs the Admin API only for the one authorized
user-creation path. The invitation must remain email- and role-pinned, single-use under
concurrency, tenant-scoped after lookup, and compensatable across the unavoidable
database/Auth boundary. `packages/shared` is frozen.

## Usage (caller's view)

An admin-facing caller creates and reveals one token:

```ts
const issued = await createInvitation(handle, {
  orgId,
  email,
  role,
  invitedBy: userId,
});
// issued.token is the only plaintext copy; issued.invitation stores only its prefix/hash.
```

The public page hashes the route token, then renders from a derived status:

```ts
const invitation = await findInvitationByTokenHash(handle, hashInviteToken(token));
if (invitation?.status !== 'pending') return renderClosed(invitation?.status);
```

The acceptance action owns the cross-system sequence:

```ts
const claimed = await claimInvitation(handle, tokenHash, existingUserIdOrNull);
// For a new account only: admin.createUser(...), compensating with unclaim on failure.
await addMember(handle, {
  orgId: claimed.orgId,
  userId,
  role: claimed.role,
  invitationId: claimed.id,
});
```

## Shape

`supabase/migrations/*_invitations.sql` owns the stored invitation shape, bespoke RLS,
and database constraints. `src/data/invitations.ts` owns token generation and hashing,
email normalization, status derivation, pending-invite exclusion, lifecycle updates,
and invitation audit writes. `src/data/members.ts` owns membership reads and mutations,
last-owner serialization/checks, and membership/acceptance audit writes. Both accept a
small structural SQL handle and require `orgId` on every tenant-scoped operation.

`src/auth/admin.ts` is a narrow server-only constructor for the Admin API. The invite
route actions are the sole saga coordinator because only they know both the external
Auth call and the writable Next cookie store. They re-read the invitation at every
attempt, claim before any new-user creation, compensate a failed provisional claim,
and take org/role/email only from the stored row.

The data interfaces are deliberately deeper than raw query helpers: callers do not
know hash storage, status precedence, audit payloads, pending-invite races, or the
last-owner locking rule. The external-auth sequence remains visible because hiding it
inside a data module would leak Supabase and Next concerns across ownership boundaries.

## Synthesis decision

The chosen base is the split aggregate design: invitation lifecycle and membership
policy remain separate, with the route action coordinating only the cross-system saga.
From the thin-primitives candidate it keeps the exact functions required by the brief;
from the all-in-one service candidate it adopts atomic lifecycle operations and
compensation. A single acceptance service was rejected because it would either import
Supabase Auth/cookies into the data layer or expose callbacks that merely disguise the
same orchestration. Raw SQL primitives were rejected as shallow modules that make every
caller relearn status, audit, and concurrency rules.

## Tradeoffs accepted

- We accept a short saga in the server action in exchange for keeping database, Auth,
  and cookie ownership explicit.
- We accept a provisional claimed row with `accepted_by = null` during new-user
  creation in exchange for winning the single-use race before creating an account.
- We accept database advisory locking in member mutation transactions in exchange for
  a concurrency-safe last-owner invariant without changing the frozen role contract.
- We accept raw SQL records local to the web app in exchange for no forbidden
  `packages/shared` change.

## Alternatives considered

- A single `acceptInvitation` service hid more call steps, but leaked Supabase Admin,
  anonymous cookie sign-in, and database policy into one module with no stable owner.
- A collection of query-shaped helpers matched execution order, but exposed status
  precedence, audit coordination, and compensation to every caller.

## Open questions and risks

- Will the hosted deployment provide the direct service-role `DATABASE_URL` and the
  separate Admin API key at the same time? Operator configuration is required before
  acceptance can work outside local tests.
- Could Auth user creation succeed while the following membership transaction fails?
  Yes; the claim is reopened, and the created user can sign in and accept as an
  existing account. The action must keep its error copy non-oracular.

## Next implementation step

Create and verify the invitations migration and tenant/RLS fixtures before building
the web data and Auth flows against that schema.
