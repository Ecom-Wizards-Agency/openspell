# Program decisions log

One line per decision the manager (Fable) or operator makes between work packages.

- **2026-08-13 · Non-converting bid formula default = `projected`** (article-004 model,
  `target × AOV/(clicks + aCTC)`); the older `simple` model (article-001, `AOV/clicks ×
  target`) stays available as `nonConvertingModel: 'simple'`. AdLabs publishes both;
  re-examine at the v1-exit optimizer parity spot-check. (WP-05 ambiguity #6.)
- **2026-08-13 · Change caps are required inputs, never repo defaults** — confirmed WP-05's
  reading; tenant config supplies caps (e.g. 0.25/0.50/0.33). (WP-05 ambiguity #8.)
- **2026-08-13 · TenantStrategy contract widened** to cover the operator's live doctrine
  shape (WP-00.1); widening-only, all new leaves optional. Gap list in the WP-00.1 brief.
- **2026-08-13 · `goal: rank-launch` → pacing condition `launch`** accepted as an
  interpretation (not published by AdLabs); revisit if parity spot-check disagrees.
  (WP-05 ambiguity #7.)
- **2026-08-13 · Recommendation.status vocabulary** frozen as
  `proposed|accepted|dismissed|exported|applied|superseded` (WP-00's judgment call;
  `superseded` replaces the plan's `expired`).
- **2026-08-14 · RPC grants hardened (migration 0013)** — hosted advisors showed the queue +
  vault SECURITY DEFINER RPCs EXECUTE-callable by anon/authenticated via PostgREST (local shim
  didn't reproduce PostgREST default grants; the in-body service-role guard still blocked use).
  EXECUTE now service_role-only; advisors clean. Lesson: hosted advisor run is part of every
  migration review.
- **2026-08-14 · Campaign generation added as WP-14** (operator request) — 14a: pure engine
  port of amazon-campaign-builder (types package-local, XLSX byte-parity, paused-by-default)
  ships in v1; 14b: API-create lane gated only on OAuth + entity sync (creation is
  lower-risk than bid writes), still per-plan operator approval through apply batches.
- **2026-08-14 · BMM dropped from campaign generation** (operator: BMM doesn't work on his
  accounts). Generation matrix is SKW/Halo/Phrase/Auto/PAT only; BMM parity scenarios
  excluded from goldens. Read-side BMM awareness (classifying existing campaigns) stays.
- **2026-08-14 · Codex-runtime handicap on this machine** — the launched-from-Claude Codex
  tasks hit two structural walls: (1) isolation worktrees are auto-cleaned when the launch
  wrapper exits, deleting the directory before Codex uses it; (2) the Codex sandbox denies
  local sockets (no Postgres), npm registry, and .git writes. Salvage: WP-03/WP-08 work
  recovered via git bundles; WP-02/WP-06 lost. All five relaunched/completed on Opus.
  Rule going forward: DB-heavy or e2e-heavy packages run on Opus; Codex is fine for pure-logic
  packages or when run attended in the Codex app with full permissions.
- **2026-08-14 · SB/SD fact contracts stay package-local for now** (WP-02 finding) — shared has
  no SB/SD fact schema; parsers return package-local rows shaped to the db tables; WP-03
  hand-maps. Promote to shared when SB/SD analytics land in the UI.
- **2026-08-14 · SB/SD attribution window** — Amazon reports one 14-day window for SB/SD while
  fact columns are named *_7d. Parsers carry attributionWindowDays=14 explicitly instead of
  silently writing 14d numbers into 7d columns. Decide the landing column at SB/SD UI time.
- **2026-08-14 · v1 hosting domain = ads.ecomwizards.agency** (operator decision;
  app.ecomwizards.agency acceptable alternate). amazonwizards.com is explicitly ruled out for
  this tool — "amazon" in a product domain violates Amazon brand guidelines and puts the LWA
  app / Ads API access at suspension risk; the exposure includes cert-transparency logs and
  the OAuth consent context, not just the callback. OAuth redirect URI:
  https://ads.ecomwizards.agency/api/amazon/oauth/callback (same-domain callback, the WP-04
  architecture). Public-launch brand comes later and will not contain "amazon".
- **2026-08-14 · Feedback & roadmap added as WP-15** (operator request) — in-tool bug/feature
  form with page context, org-scoped tracker, voting, roadmap columns from the same items,
  plus a submit_feedback MCP tool (AdLabs submit_bug_report parity, but with statuses/votes).
- **2026-08-14 · Long-term vision captured in docs/VISION.md** (operator brain-dump): per-
  campaign strategy assignment over the RPC default (stock/usage/performance-driven),
  opportunity engine ("where we can win"), doctrine knowledge pack as per-tenant data (never
  repo code), always-on Mac mini analyst. Constraint on WP-07/12: recommendation surfaces
  must carry a strategy/objective dimension so assignment can be added without rework.
- **2026-08-14 · AMC planned as WP-16** (operator request) — full lane brief (instance admin,
  S3 delivery via a single worker module, SQL workbench + curated library, AMC audiences to
  SD through apply batches, MCP tools). Gated on first provisioned instance + AWS bucket;
  sponsored-ads AMC eligibility verified per account at gate-open. Seeded onto the in-app
  roadmap so it stays visible.
- **2026-08-14 · AI skills library planned as WP-17** (operator idea, validated vs
  adlabs.app/skills) — downloadable skills against our MCP + a /connect-claude onboarding
  page with key issuance; amazon-agent skills are spec sources, every shipped skill rewritten
  public-safe (thresholds stay in tenant strategy, read via MCP at runtime). Seeded onto the
  in-app roadmap.
