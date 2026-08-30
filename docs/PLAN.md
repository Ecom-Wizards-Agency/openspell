# OpenSpell — In-house Amazon Advertising Operator

## Context

Victor is building Ecom Wizards' own Amazon Advertising tool as a standalone product: an
AdLabs-style platform (sync, analytics, RPC bid optimization, harvesting) plus features AdLabs
lacks (SUPA-style SQP×PPC analysis, DataDive rank tracking, Keepa BSR proximity alerts, a
Creative Hub, off-Amazon placement control). Later: own GitHub repo + webpage, web-based Amazon
authorization, an MCP server, and a daily headless-AI analyst.

**Working model:** Fable 5 = manager (plans, reviews, verifies). Codex + Claude Opus = builders,
working parallel work packages. Every work package gets a **handover brief as an md file** in
`docs/workpackages/WP-XX-<name>.md` — Victor kicks off an implementer with a one-line prompt
("read docs/workpackages/WP-05 and implement it"), never a long prompt.

The public repository and package identifiers remain `wizard-ads` and `@wizard-ads/*` until a
separate infrastructure migration is planned. User-facing product copy uses **OpenSpell**.

**Key facts established during research (2026-08-13):**

- **Amazon Ads API access is LIVE.** LWA app has `advertising::campaign_management`, OAuth done
  2026-08-13, refresh token in `amazon-agent/_local/ads-monitor/config.json`, `GET /v2/profiles`
  returns 211 profiles (NA 71, EU 138, FE 2). Existing OAuth worker:
  `amazon-agent/tools/ads-auth/callback-worker/` (auth.ecomwizards.agency).
- **SP-API pending** (public-developer upgrade). v1 ships without it; clean seam for total
  sales/TACOS, SQP (SUPA), inventory later.
- **Prior planning doc**: `~/os/personal/Projects/amazon-ads-tool/README.md` (2026-07-29).
  Carried-over decisions: own repo · read-only first · "v1 proposes, the operator applies" ·
  writes only after numbers match AdLabs side by side · job queue not request/response ·
  429-only throttling → backoff day one. Its "BLOCKED" status is stale — update at kickoff.
- **AdLabs' algorithm is public** ("White Box"): Bid = RPC × Target ACOS; four reasons (High
  ACOS / High Spend no sales / Low ACOS / Low Visibility); Data Confidence Hierarchy
  (keyword→ad group→campaign→profile AOV/CVR fallback); layered ceilings; change caps
  (−25/−50% down, +33% placement up); Placement Adj = (Target ACOS / Current ACOS) − 1.
  Offline copies: `amazon-agent/AdLabs Help/articles/`.
- **AdLabs MCP surface documented** in `amazon-agent/skills/amazon-audit/references/source-adlabs.md`
  (+ gotchas in `amazon-agent/docs/ads-runtime-notes.md`).
- **"SUPA"** = in-house SQP×PPC analyzer at `amazon-agent/tools/sqp-supa/` (weekly SQP share ×
  ad spend/sales per keyword per ASIN; P1/P2/P3 flags). Needs SP-API SQP → v2 lane.
- **LinkedIn features decoded** (Alexander Swade, SYNQ): off-Amazon SP placement = per-campaign
  attribute (bulk col AQ) + reportable placement + leakage report · Creative Hub = asset-centric
  creative table, dedupe one-row-per-asset, winners/losers, bulk fan-out/pause · SQP cannot
  replace rank tracking (absence is data; ads inflate SQP share) → build a reconciliation view ·
  Keepa BSR proximity alerts = relative subcategory BSR gap vs competitor with threshold +
  deep links. Keepa client reference: `wizards-ai/keepa_client.py`.
- **Portable doctrine code** (Python, port to TS with selftests as ground truth):
  `amazon-agent/tools/amazon-ads-monitor/{flags,recommendations,pacing,analyze,crosscheck,datasource}.py`,
  `tools/amazon-ppc-management/batches.py`, `tools/amazon-campaign-builder/`. Confidential
  thresholds (`_local/ads-strategy/strategy.json`) become per-tenant DB config, never repo code.
- **Ads API alone covers**: SP/SB(v4)/SD management, placement + off-Amazon controls, budgets,
  Reporting v3 (async, GZIP_JSON, ≤3h latency), Marketing Stream, SB creative/video APIs, AMC.
  **SP-API needed for**: total sales/TACOS, SQP, inventory, listings. **Neither**: BSR (Keepa),
  organic rank (DataDive).

## Decisions (locked with Victor, 2026-08-13)

| Decision | Choice |
|---|---|
| Location | `~/os/wizard-ads` (sixth ~/os project; register in root `AGENTS.md` + `company-ai-skills/docs/dependencies.md`) |
| Name | **OpenSpell**; repository and package identifiers remain stable initially |
| Tenancy | Internal-first, SaaS-ready (multi-tenant schema/auth day one; no signup/billing in v1) |
| Stack | Next.js (Vercel) + Supabase (Postgres/Auth/pg_cron) + long-lived job worker; MCP on the always-on operator host behind Cloudflare Tunnel; **all TypeScript** monorepo |
| Apply posture | Preview by default; exact operator-approved batches may write through the worker. Unattended writes require an explicitly enabled cadence |
| AdLabs recon | Yes — logged-in Chrome UI walkthrough + MCP surface → specs (Victor logs in) |
| Costs | Supabase free → Pro only when measured storage/compute requires it; MCP uses the existing operator host and Cloudflare Zero Trust free tier. Any separate job-worker hosting is approved from measured need. |
| Handover | One md brief per work package in `docs/workpackages/`; agents launched with one-liners |

## Monorepo structure

pnpm workspaces + Turborepo. Package boundaries = work-package ownership, so parallel agents
never touch the same files.

```
wizard-ads/
├── AGENTS.md                      # repo rules (public-safe, amazon-agent conventions)
├── apps/
│   ├── web/                       # Next.js App Router (Vercel): auth, org switcher,
│   │   │                          #   dashboard/grid/recommendations/ngram/tags/settings,
│   │   ├── app/api/amazon/oauth/  #   LWA start + callback (server-side code exchange)
│   │   └── app/go/[token]/        #   goto deep-link resolver
│   ├── worker/                    # TS sync worker on long-lived compute: job claim loop (FOR UPDATE
│   │                              #   SKIP LOCKED), report request/poll/fetch handlers,
│   │                              #   per-region token buckets + 429 backoff
│   └── mcp/                       # MCP server (@modelcontextprotocol/sdk, Streamable HTTP),
│                                  #   Evo container behind Cloudflare Tunnel; API-key auth per org
├── packages/
│   ├── shared/                    # THE contract package: zod schemas/types for every cross-
│   │                              #   package shape. Frozen early; changes need Fable sign-off
│   ├── db/                        # Drizzle schema + typed queries + RLS test helpers
│   ├── ads-api/                   # Amazon Ads API client (LWA refresh, profiles, entities,
│   │                              #   Exports, Reporting v3, backoff). Pure client, no DB
│   ├── sp-api/                    # Selling Partner API Reports client (worker-only, no DB)
│   ├── core/                      # Doctrine engine, pure functions ZERO I/O: analyze, flags,
│   │                              #   pacing, recommendations, White Box bidding, ngram,
│   │                              #   crosscheck
│   ├── strategy/                  # Tenant config layer (defaults ← goal lens ← tenant/profile);
│   │                              #   ships strategy.TEMPLATE.json ONLY
│   └── ui/                        # DataGrid (TanStack Table+Virtual), charts, tiles
├── supabase/migrations|functions|seed
├── fixtures/generate|golden       # Python→TS parity harness goldens (synthetic only)
├── tools/crosscheck-cli|recon     # AdLabs CSV crosscheck CLI; recon output specs
├── docs/workpackages/             # WP-XX handover briefs (the one-liner kickoff files)
└── _local/                        # gitignored; *.TEMPLATE.json tracked
```

Dependency direction (enforced): `shared` ← `core`/`strategy`/`ads-api`/`sp-api`/`db` ← `web`/`worker`/`mcp`.
`core` never imports `db`, `ads-api`, or `sp-api`. wizard-ads consumes no sibling project at
runtime (Python reference tools are build-time spec sources via the fixtures generator only).

## Database schema outline

Supabase Postgres; all tenant tables carry `org_id` + RLS; worker uses service role.

- **Tenancy**: `orgs`, `org_members` (roles owner|admin|analyst|viewer), `ads_connections`
  (refresh token in Supabase Vault via security-definer RPC), `ad_profiles` (211 rows day one;
  `sync_enabled` gates cost; per-profile target ACOS/goal lens/monthly budget),
  `profile_strategy` (confidential doctrine as per-tenant jsonb, seeded by operator-run script
  from gitignored local file).
- **Entity mirror** keyed `(profile_id, amazon_id)`: `portfolios`, `campaigns` (ad_product,
  budget, placement modifiers), `ad_groups`, `product_ads`, `keywords`, `targets`, `negatives`;
  `entity_changes` diff audit (source sync|apply).
- **Facts** (monthly range partitions on date, BRIN + (profile_id,date) indexes):
  `fact_sp_target_daily` (target-day grain incl. top_of_search_impression_share),
  `fact_search_term_daily`, `fact_placement_daily` (seam for off-Amazon leakage),
  `fact_sb_daily`, `fact_sd_daily`, `fact_profile_daily` rollup. Retention: 26 months daily
  (13 for search terms) → monthly aggregates, drop partitions.
- **Sync machinery**: `sync_schedules`, `sync_jobs` (queue + ledger in one; dedupe_key,
  attempts, dead), `report_requests` (request/poll/fetch state machine spine; rows_loaded vs
  parsed count = Rule 45 as data).
- **Analysis**: `recommendation_runs` + `recommendations` (reason, current→proposed, full
  `inputs` provenance jsonb — "show your work" beats AdLabs' black-box weighting), `insights`
  (headless analyst), `crosscheck_results`.
- **Writes (v1.x; schema now, unused in v1)**: `apply_batches`/`apply_rows` (port of batches.py:
  staged|applied|reverted, cooldown, scoring), `campaign_maps` (harvesting; destination
  template jsonb = auto-create destinations, the AdLabs limitation we beat).
- **Product surface**: `tags` (nested) + `entity_tags`, `dashboards` (+ white_label,
  share_token), `goto_links`, `audit_log` (every MCP call and write).
- **Later seams (reserved migrations, no code)**: `spapi_connections`,
  `fact_sales_traffic_daily`, `fact_sqp_weekly` + `supa_flags`, `rank_observations` (DataDive),
  `keepa_bsr_observations` + `competitor_links`, `creative_assets` + `creative_placements`.

## Sync architecture

- **OAuth through the webpage** (apps/web owns it): signed state (org + session bound, 15-min
  expiry, same pattern as existing callback-worker) → server-side code exchange (secret only in
  Vercel env) → refresh token into Supabase Vault → immediate `/v2/profiles` per region →
  upsert 211 `ad_profiles`. Register the new redirect URI on the existing LWA app. The
  Cloudflare worker stays for CLI flows; wizard-ads doesn't depend on it.
- **Tokens**: web never holds Amazon tokens; worker caches access tokens in memory, refreshes
  60s early (pattern from `SPAdsApiDataSource._get_access_token`).
- **Scheduler**: pg_cron (5-min tick) turns due `sync_schedules` into `sync_jobs`; a long-lived
  worker claims via FOR UPDATE SKIP LOCKED, per-region token buckets,
  exponential backoff honoring Retry-After. Edge functions rejected as executor (400s limit,
  3h report polling, heavy GZIP downloads). A Cloudflare Tunnel is ingress, not worker compute;
  Cloudflare Workers are not used for these long report jobs. Queue is ~200 lines, no BullMQ.
- **Pipelines**: entity sync daily (list endpoints + Exports API for bulk + campaign-name join —
  closes datasource.py's documented gap) with snapshot-diff → `entity_changes`. Reporting v3 as
  **three separated passes**: `report.request` → `report.poll` (5→10→20→30 min intervals, give
  up at 4h) → `report.fetch` (stream gunzip, COPY staging, MERGE into partition, count parsed
  vs loaded). **Restatement**: daily re-pull trailing 3 days, weekly trailing 35 (sales
  attribute late; idempotent upserts on grain key). v1 report types: spCampaigns (target),
  spSearchTerm, placement grouping, sbCampaigns, sdCampaigns; budget usage via Budgets endpoint
  on entity pass.
- **Ramp deliberately**: pilot profiles daily, long tail weekly/on-demand; 211×5 reports at
  once is how you find the invisible quota (429-only, no headers).

## Operator-managed module scope

1. Auth + orgs (Supabase Auth, seeded Ecom Wizards org, roles; no signup).
2. Connections & profiles (OAuth, roster, per-profile sync_enabled + targets editable).
3. Sync engine + sync-status page (jobs, report ledger, freshness — operator trust starts here).
4. Dashboard: spend/sales/ACOS/CPC trends vs prior + trailing-7 (analyze.py port), pacing
   widget (pacing.py incl. fixed cut order waste→discovery→profit→rank), flags panel with
   suppressed list shown as "noted, not flagged", freshness + crosscheck verdict banner.
5. Data grid: AdLabs-style no-pagination virtualized grid, saved views, filter DSL, group-by
   with recalculated derived metrics (ACOS = sum/sum, never averaged ratios), CSV export.
6. Recommendations engine (`core`): flags/pacing/recommendations ports + White Box bidding
   (RPC × Target ACOS, four reasons, confidence hierarchy, ceilings incl. 50% budget cap for
   SD, caps as clamps, placement adj computed separately on ≥30d windows; Rank/SKW never cut on
   ACOS alone; goal lenses honored). Output = proposals with full inputs provenance.
   The apply path supports both export and an immutable worker-executed Advertising API batch.
   API application requires an exact preview, separately recorded approval, profile write
   enablement, idempotent row identities, per-row response counts, and post-write resynchronization.
7. N-gram explorer (uni/bi/tri over search terms; negative candidates as proposals).
8. Nested tags (also the client-grouping mechanism for 211 profiles) + tag-scoped views.
9. Goto links (`/go/[token]` → route + filter state).
10. MCP server with analytical reads plus approval-gated batch triggering. MCP may draft a batch
    or trigger one approved elsewhere; it cannot approve its own mutation, create a cadence, or
    call Amazon directly. Every call is audited.
11. Crosscheck harness: nightly per-profile facts vs AdLabs MCP `download_data` exports,
    ±7% tolerance (crosscheck.py port), same-day-provisional exclusion, results dashboard.

**v1 evidence criterion (gates scaled automation, not explicitly approved manual batches):** on
≥5 pilot profiles across NA+EU: (a) 14 consecutive
days of `verified` profile-grain verdicts, (b) campaign-grain spend/sales within ±7% for ≥95% of
spending campaigns over a week, (c) one-week optimizer parity spot-check — our proposals match
White Box math exactly; divergence from AdLabs preview only where their trade-secret weighting
layer is (explained, not eliminated).

## Phase plan

The sequence below is the original architecture plan, not a current status board. The dated owner
labels and duration estimates are retained as history. `docs/STATUS.md` is authoritative for what
is merged, deployed, live-gated or still open.

As of 2026-08-29, the analytical parts of several originally v2 lanes have been pulled forward:
Asset-ID creative storage and its operator surface, weekly SQP/query intelligence, Marketing
Stream/dayparting storage and UI, and stock-aware strategy context now exist. Their provider
authentication, subscription and live parity gates remain explicit. Direct apply is now an
approved product direction under `AGENTS.md`, but it is not implemented or live merely because
the policy changed. Scaled automation, unattended dayparting, and MCP mutation still require the
evidence criterion plus their action-specific gates.

- **v0 (~2 wks)** — skeleton proves the loop: scaffold + frozen contracts, ~/os registration,
  Supabase project + migrations + RLS, OAuth live with 211 profiles listed, entity sync +
  spCampaigns daily report for 2 pilot profiles end-to-end into facts, minimal grid, fixtures
  generator producing Python goldens. **AdLabs recon runs in parallel during v0** (feeds UI
  specs). Supabase Pro decision at v0 close.
- **v1 (~6 wks after v0)** — everything above; exit = crosscheck criterion.
- **v1.x (active implementation lane)** — staged-apply write engine (batches.py port: preview → approve →
  apply via Ads API, snapshot/revert/cooldown, scoring) · harvesting via campaign maps incl.
  destination auto-creation (campaign_model.py port) · N-gram → negatives push · approval-gated
  MCP batch triggers (every mutation = an audited apply batch; only legal inverse changes are
  restorable) · **headless analyst** (Claude Agent SDK
  scheduled run, reads via MCP only, writes `insights` + Slack digest via the guarded Wizards
  AI helper; per-profile Context-Manager-equivalent doc as MCP resource; optional amazon-agent
  context on the operator-machine variant) · white-label shareable dashboards.
- **v2 (each lane gated on its external dependency)** — SP-API activation: TACOS everywhere,
  SQP → **SUPA module** (P1/P2/P3 port with stock-first evaluation), inventory stock-gate for
  the optimizer · DataDive Rank Radar ingestion → rank-aware keyword rows · Keepa BSR
  competitor-proximity alerts · Creative Hub (SB v4 media APIs, asset dedupe, winner fan-out,
  loser bulk-pause) · off-Amazon placement control + leakage report · SQP-vs-rank
  reconciliation view · Marketing Stream/dayparting, AMC last (AWS plumbing).

## Work packages — who builds what

**Codex** gets the mechanical, contract-bounded builds; **Opus** gets fidelity/judgment-heavy
ones. Each WP ships as a handover brief `docs/workpackages/WP-XX-<name>.md` (context, spec,
files to read, interfaces, acceptance checks) — written by Fable in v0 step 2.

| WP | Package | Owner | Acceptance check (Fable verifies) |
|---|---|---|---|
| 0 | Scaffold + contracts (`shared`, CI, AGENTS.md, ~/os registration) | **Opus** | CI green; contracts cover all cross-package types; no client names/thresholds greppable |
| 1 | DB schema + RLS + partitions (`db`, migrations) | **Opus** | Migrations clean; RLS negative test (org A ∕ org B); partition automation; strategy seed from `_local/` |
| 2 | `ads-api` client (port datasource.py 731–1030) | **Codex** | Fixture tests incl. 429/Retry-After/gzip; live smoke: request→poll→download 1 real report, print row count |
| 3 | Worker + queue + pg_cron scheduler | **Codex** | Fake-API integration: full request→poll→fetch→facts; kill-and-resume survives; parsed == loaded asserted |
| 4 | Web auth + orgs + LWA OAuth + connections UI | **Codex** | Playwright: mocked-LWA connect lands profiles; token only via service RPC; state tampering rejected |
| 5 | `core` doctrine port + White Box bidding | **Opus** | Parity suite: TS byte-equals Python goldens for every selftest scenario; worked-example bid tests pass |
| 6 | Data grid + dashboard UI | **Codex** | 50k-row grid smooth; group-by ACOS verified vs SQL; visual review vs recon screenshots |
| 7 | Recommendations/N-gram UI + export bridge | **Codex** | Exported rows JSON passes `batches.py validate`; XLSX opens in campaign-builder update flow unmodified |
| 8 | Tags + goto links | **Codex** | Tag → filter grid+dashboard; goto round-trips filter state; expired token 404s |
| 9 | MCP analytical server | **Opus** | Claude session answers "top 10 wasted-spend targets last week" correctly vs SQL; calls in audit_log |
| 10 | Crosscheck harness + exit-report generator | **Opus** | Corrupted fixture → `mismatch`; live pilot run produces verdict table matching AdLabs UI |
| 11 | AdLabs recon (Chrome walkthrough, Victor logs in) | **Opus** + operator | Spec per screen w/ screenshots; coverage checked vs AdLabs nav map |
| 12 | Guarded Advertising API write engine (v1.x) | **Opus** | Exact approval, idempotency and conflict gates hold; restore verifies the expected old value; over-cap delta is refused |
| 13 | Headless analyst (v1.x) | **Opus** | Daily insight with correct figures; audit_log proves zero write calls |

Day-1 parallel set after WP-0 (~2 days): WP-1, 2, 3, 4, 5, 11 simultaneously — six agents, no
file overlap. WP-6/7/8 start when recon + contracts land; WP-9/10 at v0 close; WP-12/13 gated
on v1 exit.

### Active operator-experience queue

The historical table above explains the original build. Current operator work continues with
numbered briefs in `docs/workpackages/`; status and release gates remain in `docs/STATUS.md`.

- **WP-89 — Data context and filtered bulk selection:** make routine freshness compact, keep
  warnings prominent, explain provenance through an accessible info affordance, and support
  select-all/deselect-all within the currently filtered campaign set.
- **WP-90 — Optimization-group review schedule:** replace the ambiguous interval-only cadence
  control with persisted profile-local weekday choices. Due-group evaluation must honor the
  chosen days and generate previews only in this package. A separate, explicitly enabled apply
  cadence is required for unattended Amazon writes through the guarded worker gateway.
- **WP-91 — Live interaction performance:** profile the deployed server query, payload,
  hydration and render paths. The known 3,597-row grid must become usable in under two seconds;
  p95 filter/group interactions must remain below 150 ms. Time Machine and other slow operator
  routes receive the same evidence-first breakdown rather than a generic loading-state patch.
- **WP-124 — Multi-product campaign creation architecture:** freeze SP, SB, SB Video, and
  Sponsored Display creation as immutable, tenant-scoped dependency graphs. Replace the
  unverified legacy media seam with the current Asset Library lifecycle and an Asset-ID/version
  preview. Only the environment- and profile-gated worker may execute an exactly approved plan.
  Creation remains separate from inverse-capable scalar mutations because Amazon resources cannot
  be deleted as a rollback. Implementation is serialized across shared contracts, provider
  reads/adapters, persistence, pure projection, worker, web, and live evidence.

## Verification strategy

1. **Parity harness**: `fixtures/generate/` Python scripts import the real amazon-agent modules,
   run every selftest scenario (synthetic data only), dump `{input, expected}` goldens; Vitest
   replays and asserts deep equality (6dp). Bidding engine gets worked-example tests from the
   AdLabs formula articles.
2. **API contract tests**: recorded fixtures for every endpoint incl. 429/425/PENDING paths;
   one gated live smoke reading creds from `_local/`.
3. **Crosscheck vs AdLabs**: the running nightly check + the v1 exit gate + optimizer parity
   spot-check.
4. **E2E**: Playwright (OAuth, grid, recommendations), worker kill/resume, count verification
   everywhere (Rule 45 as assertions), RLS negative tests in CI.
5. **Public-repo hygiene gate**: CI secret scan + lint rejecting client names/threshold
   literals outside TEMPLATE files (modeled on `lint_agent_docs.py`).

## Execution order (what happens after approval)

1. Scaffold `~/os/wizard-ads` (WP-0, Opus) and register it in `~/os/AGENTS.md` +
   `company-ai-skills/docs/dependencies.md`; update the stale status in
   `~/os/personal/Projects/amazon-ads-tool/README.md` (points to the new repo).
2. Fable writes all handover briefs into `docs/workpackages/` (from this plan + research).
3. Launch the day-1 parallel set (WP-1..5 to their owners; WP-11 scheduled with Victor for the
   AdLabs login session).
4. Supabase project creation (free tier); choose the job-worker host from measured runtime and
   reliability needs; flag Victor before a paid Supabase upgrade and for the new LWA redirect URI
   registration.
5. Fable reviews each WP against its acceptance checks before merge; contracts change only
   through WP-0's owner with Fable sign-off.

## Top risks (full list in docs/ later)

429-only throttling at 211-profile scale (ramp pilot-first) · report latency + late sales
restatement (three-pass sync + re-pull cadence are load-bearing) · same-day data provisional
(exclude from crosscheck) · Exports API contract unverified live (WP-2 smoke first) ·
zero-impression rows omitted (freshness from `report_requests`, never inferred from facts) ·
timezone/currency across NA/EU/FE · Supabase free tier dies during backfill (planned Pro
upgrade) · public-repo exposure (CI gate from day one) · single agency refresh token = SPOF
(hourly health-check + Slack alert) · writes are client money (keep every batches.py safety in
the port, gate on v1 exit).
