# WP-00 — Scaffold + contracts

**Owner:** Claude Opus · **Phase:** v0 · **Depends on:** nothing · **Blocks:** every other WP

## Goal

Stand up the monorepo skeleton and freeze the cross-package contracts so six agents can build
in parallel without file overlap.

## Read first

- `docs/PLAN.md` (approved plan — monorepo structure section is your layout spec)
- `docs/workpackages/README.md` (program rules)
- `~/os/amazon-agent/AGENTS.md` — conventions to mirror (gitignored `_local/`, `*.TEMPLATE.json`
  tracked, safety-rules tone). Do NOT copy client-specific content.
- `~/os/amazon-agent/tools/lint_agent_docs.py` — model for the hygiene lint.

## Spec

1. **Monorepo:** pnpm workspaces + Turborepo, TypeScript strict, Node 22. Layout exactly as
   `docs/PLAN.md` "Monorepo structure": `apps/{web,worker,mcp}`, `packages/{shared,db,ads-api,
   core,strategy,ui}`, `supabase/`, `fixtures/{generate,golden}`, `tools/{crosscheck-cli,recon}`,
   `_local/` (gitignored). Each package: `package.json`, `tsconfig`, `src/index.ts` stub, empty
   Vitest suite. apps/web = Next.js 15 App Router (create-next-app baseline, no UI work).
2. **`packages/shared` — the contract package.** Zod schemas + inferred types, no logic, no
   deps beyond zod:
   - `Region` (NA|EU|FE), `AdProduct` (SP|SB|SD), `EntityType`, `MatchType`, `EntityState`
   - `EntityRow` (campaign/adGroup/keyword/target/negative/productAd variants)
   - `DailyFact` (target grain: impressions, clicks, cost, purchases/sales 1d/7d/14d/30d,
     unitsSold7d, topOfSearchImpressionShare?), `SearchTermFact`, `PlacementFact`, `ProfileFact`
   - `Recommendation` (reason enum: high_acos|high_spend_no_sales|low_acos|low_visibility|
     flag|pacing; entityRef, currentValue, proposedValue, `inputs` provenance object —
     rpc, clicks, cvrSourceLevel keyword|ad_group|campaign|profile, ceilingApplied,
     capClamped — status enum)
   - `ApplyRow` (entityType keyword|target|campaign|ad_group|placement, entityId, field, old,
     new, name) — must stay byte-compatible with the row shape in
     `~/os/amazon-agent/tools/amazon-ppc-management/batches.py` (read it)
   - `TenantStrategy` (shape mirrors `~/os/amazon-agent/_local/ads-strategy/strategy.json` —
     ask the operator for the SHAPE via the template; NEVER commit its values. Model on
     `~/os/amazon-agent/tools/amazon-seo-keyword-workbook/ads-strategy.TEMPLATE.json` if
     readable, else define from PLAN.md: pacing, opt_groups, rank_lifecycle, staged_apply,
     bids, sv_bands, caps, pat_split, naming)
   - `JobPayload` discriminated union: entity.sync | report.request | report.poll |
     report.fetch | crosscheck.ingest | recommendations.run
3. **CI:** GitHub Actions workflow (typecheck, lint, test, hygiene) — committed even though
   the repo isn't on GitHub yet. Also a local `pnpm check` running the same.
4. **Hygiene lint** (`tools/hygiene-lint`, runs in CI): fails on (a) tracked files containing
   `/Users/` paths, (b) candidate secrets (basic entropy/keyword scan), (c) a denylist of
   client names read from gitignored `_local/hygiene-denylist.txt` (skip check with warning if
   absent), (d) untracked-and-unignored top-level dirs.
5. **`AGENTS.md`** (repo root, public-safe): what the project is, package map + dependency
   direction, program rules from `docs/workpackages/README.md`, contract-freeze rule, public-
   repo hygiene rules.
6. **`.gitignore`:** `_local/` (except `*.TEMPLATE.*`), `node_modules`, `.next`, `.turbo`,
   `.env*`, `fixtures/golden/**/*.local.*`.
7. Root `README.md`: one-paragraph description + quickstart.

## Out of scope

DB schema (WP-01), any Amazon API code (WP-02), UI beyond the Next.js baseline (WP-06),
registration edits in `~/os/AGENTS.md` (manager does those).

## Acceptance checks

- `pnpm install && pnpm check` green from clean clone.
- `packages/shared` exports every type listed above; `zod` parse round-trips a sample of each.
- Hygiene lint catches a planted absolute home-directory path (the operator's own) and a
  planted fake key in a test run. Written without the literal: the lint forbids exactly that
  string in a tracked file, and this brief is tracked.
- Grep over tracked files finds no client names, no threshold values, no secrets.
- All work on branch `wp-00-scaffold`; report per acceptance check.
