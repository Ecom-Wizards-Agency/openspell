# wizard-ads

An in-house Amazon Advertising platform: it syncs advertising profiles and entities,
ingests Reporting v3 asynchronously, stores facts at target, search-term, placement
and profile grain, and produces bid and budget recommendations that show their work.
Version 1 is deliberately read-only. It proposes and the operator applies; accepted
proposals leave as an export rather than an API write, and write access unlocks only
once our numbers have matched an established tool side by side on real profiles for a
sustained period. Built as a TypeScript monorepo: Next.js on Vercel, Supabase for
Postgres, auth and scheduling, and a small always-on worker for the parts of Amazon's
API that take hours rather than milliseconds.

## Quickstart

```bash
pnpm install
pnpm check        # typecheck, lint, test, hygiene. The same four steps CI runs.
pnpm --filter @wizard-ads/web dev
```

Node 22 or newer. pnpm is pinned in `package.json`; enable it with `corepack enable`
if it is not already on the machine.

Optional local setup, both gitignored:

```bash
cp _local/hygiene-denylist.TEMPLATE.txt _local/hygiene-denylist.txt
cp _local/strategy.TEMPLATE.json        _local/strategy.json
```

The first turns on the client-name check in `pnpm hygiene`. The second is the tenant
doctrine document; it is seeded into the database and never committed.

## Where things are

| | |
|---|---|
| Architecture and phase plan | `docs/PLAN.md` |
| Program status | `docs/STATUS.md` |
| Work package briefs | `docs/workpackages/` |
| Rules for agents and humans | `AGENTS.md` |
| The cross-package contracts | `packages/shared` |

This repository is public. Read the hygiene section of `AGENTS.md` before your first
commit.
