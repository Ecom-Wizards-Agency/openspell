# WP-39 design rationale

## Problem

Add member administration and password management without moving invitation or membership
policy out of the data modules that already own it. The members screen must reveal a plaintext
invite URL once, independently enforce every hidden control in a server action, distinguish an
owner-only role transition from general member administration, and turn last-owner races into a
calm answer. The account screen uses Supabase Auth rather than the application database. The e2e
session seam must gain an email without weakening its development-only guard.

## Usage (caller's view)

The server page resolves one organisation and hands serializable records to one interactive
surface:

```tsx
const [members, invitations] = await Promise.all([
  listMembers(handle, active.orgId),
  listPendingInvitations(handle, active.orgId),
]);

return <MembersManager members={members} invitations={invitations} actor={actor} />;
```

Each client form calls one action and receives display-ready state. The create action is the only
caller that ever receives the plaintext token:

```tsx
const [result, create, pending] = useActionState(createInvite, IDLE_INVITE_RESULT);
return <form action={create}>...</form>;
// result.inviteUrl exists only in this mounted action state and disappears on reload.
```

The account form has the same small interaction contract while its action owns the Auth call:

```tsx
const [result, change, pending] = useActionState(changePassword, IDLE_ACTION_RESULT);
return <form action={change}>...</form>;
```

## Shape

`settings/members/page.tsx` owns entry gating, refusal rendering, concurrent reads, and derivation
of whether the final owner has editable controls. `manager.tsx` owns only ephemeral form state,
copy affordance state, and presentation. `actions.ts` exposes four mutation-shaped server actions:
create, revoke, change role, and remove. Every action gates and authorizes before parsing ids or
calling the existing data aggregate. Owner transitions are checked against a fresh member read in
the action; the SQL layer remains the final concurrency-safe last-owner authority.

`settings/account/page.tsx` gates any member and renders a focused password form.
`settings/account/actions.ts` validates matching passwords and the ten-character minimum before
constructing the server Supabase client and calling `auth.updateUser`.

The action result is a small discriminated union. It hides thrown framework/provider errors and
gives client components only the message and, for successful creation, the one-time invite URL.
Stored invitation records never gain a plaintext field. This is a deep boundary: callers do not
coordinate authorization, role-transition policy, row-count interpretation, token URL assembly,
or error translation.

The e2e seam adds a second test-only cookie for email. `currentUser()` reads it only inside the
existing `e2eAuthEnabled()` branch, so production still cannot activate or observe the seam.

## Synthesis decision

The client-manager/server-action candidate is the base because it keeps the shown-once secret in
ephemeral action state and keeps call chains short. From the server-only candidate it keeps native
forms, progressive submission, and route revalidation. From the JSON-route candidate it keeps
explicit serializable outcomes, but rejects the extra HTTP surface and duplicated request parsing.

The server-only redirect candidate was rejected because putting the invite URL in a query string
would write the secret into browser history and logs. A client manager over JSON routes was
rejected as pass-through transport: each endpoint would repeat the authorization and parsing that
a server action already supplies. One server action with an operation discriminator was rejected
as a shallow interface that makes every caller and test understand unrelated input shapes.

## Tradeoffs accepted

- We accept small client components in exchange for copy feedback and genuinely shown-once state.
- We accept a policy read before member mutation in exchange for specific owner/refusal copy; SQL
  still decides the race.
- We accept one additional test-only cookie in exchange for preserving the established UUID cookie
  and making existing-user invitation acceptance realistic.
- We accept route revalidation after each successful mutation in exchange for keeping the server
  page as the roster's single source of truth.

## Alternatives considered

- Server-only forms plus redirects hide client state, but expose the plaintext invite URL to URL
  history and cannot meet the shown-once contract safely.
- JSON endpoints plus a client store hide Next action mechanics, but expose a larger transport
  interface and duplicate policy at another boundary.
- A single polymorphic mutation action reduces export count but exposes all operation-specific
  fields and branching to every caller.

## Open questions and risks

- Could membership change between the action's explanatory read and SQL mutation? Yes; does the
  action treat a zero-row write as a last-owner or stale-member refusal rather than success?
- Could a copied URL survive a refresh? No; is plaintext kept exclusively in the action result and
  omitted from all persisted or query-string state?
- Could the email seam activate in production? No; is it read only after the existing production
  refusal has run?

## Next implementation step

Build the action result contracts and members server actions, then render the client forms against
those signatures.
