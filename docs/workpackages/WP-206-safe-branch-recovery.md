# WP-206 — Safe legacy-branch recovery

Owner: the exact narrow files listed below.

Depends on: current `origin/main` at
`51a56b392ab524dc140e343fe1dc87b58e17c42f` and the read-only inventory of the local
`codex/onepassword-secrets` branch at
`9e59587f54faca5145b849a5df7e839418d600e5`.

## Objective

Preserve the only two useful application behaviors found in the obsolete local branch without
merging, cherry-picking, pushing or otherwise publishing its unsafe lineage. Keep operator-only
1Password and Supabase CLI state out of Git status and tracked content.

## Owned files

- `.gitignore`;
- `apps/web/app/roadmap/board.tsx`;
- `apps/mcp/src/keys.ts`;
- `apps/mcp/src/keys.test.ts`;
- `apps/mcp/src/server.test.ts`; and
- this brief.

## Required behavior

1. Ignore `.1password/` and `supabase/.temp/`; do not add, inspect into public output, move or
   commit their operator-local contents.
2. Contain long roadmap cards inside their grid column with the same `minWidth: 0` and
   `overflow: hidden` contract already used by the Bugs board.
3. Treat raw API-key timestamp columns as `Date | string` because the shared Drizzle-backed raw
   client returns timestamp strings. Convert every nullable and required timestamp to a valid
   `Date` before exposing `ApiKeyRecord`; reject invalid values with a fixed non-sensitive error.
4. Preserve the current SQL-side read scope, profile allowlist, expiry, revocation, lifetime,
   organization and constant-time token checks unchanged.
5. Do not copy or edit `ops/evo`, secret-manager locators, deployment behavior, credentials,
   migrations, hosted state, services or Amazon behavior.

## Acceptance

- focused MCP typecheck and tests pass, including a real-database assertion that issued and listed
  API-key timestamps are `Date` instances;
- web typecheck and the repository lint/hygiene gates pass;
- the diff contains only the owned files and no content from the obsolete branch lineage;
- one High correctness review and two Extra-High security/blast-radius reviews accept the exact
  staged hash;
- immediately before deletion, the legacy branch is absent from every worktree and remote, and the
  accepted WP-206 commit is an ancestor of a freshly fetched `origin/main`; delete the local ref
  with atomic compare-and-delete against the inventoried commit above (`git update-ref -d` with the
  expected old object ID), which refuses cleanup if the ref moved;
- the three reflog-only merge states found during inventory are intentionally not preserved: they
  are integration snapshots atop the obsolete runtime lineage, while each merged topic commit is
  already contained in current `main`; exact SHA evidence remains in the operator's local Git/T3
  recovery metadata rather than a new branch, tag, bundle or remote ref;
- exact-head PR CI and exact-main CI pass before the legacy branch ref is deleted; and
- the original worktree ends on clean `main`, while the separate WP-201 worktree remains untouched.
