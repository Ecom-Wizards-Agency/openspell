# WP-14 — Campaign generation

**Owner:** Claude Opus · **Phase:** 14a in v1, 14b in v1.x · **Depends on:** WP-00/00.1/05 (merged)

## Goal

Generate complete Sponsored Products campaign structures from a keyword list or plain brief —
the amazon-campaign-builder capability, inside the tool. 14a is the pure engine + exports;
14b (LATER, separate gate) creates the campaigns via the Ads API, paused by default, through
the audited apply-batch path.

## 14a spec (this brief)

1. **New package `packages/campaigns`** (pure logic; may depend on shared + strategy only).
   **Scope cut (operator, 2026-08-14): BMM campaigns are DROPPED from generation** — Victor
   confirmed BMM doesn't work on his accounts. Generate only SKW/Halo/Phrase/Auto/PAT.
   Exclude BMM scenarios from the parity goldens. Do NOT remove BMM from anything that reads
   existing accounts (e.g. core's campaign-name classification) — existing campaigns may still
   carry BMM names; only generation drops it.
   Port the create-mode generation from:
   - `~/os/amazon-agent/tools/amazon-campaign-builder/campaign_model.py` (615L — the model:
     campaign type matrix SKW/Halo/BMM/Phrase/Auto/PAT, naming conventions, per-purpose
     bidding defaults, budgets, negatives, structure rules)
   - `~/os/amazon-agent/tools/amazon-campaign-builder/build_campaigns.py` (assembly)
   - `~/os/amazon-agent/tools/amazon-campaign-builder/README.md` + `references/
     bulksheets-2.0-reference.md` (output format rules)
   - `~/os/amazon-agent/tools/amazon-seo-keyword-workbook/fill_campaign_structure.py` +
     `ads-strategy.TEMPLATE.json` (how strategy config drives structure)
   Inputs: keyword rows (text, match intent, SV band, bucket) or a parsed brief + a
   TenantStrategy (bids.start_bid_pct_of_recommended, by_bucket, sv_bands, caps, pat_split,
   naming — all already in the widened contract). Outputs: a typed `CampaignPlan` (campaigns →
   ad groups → keywords/targets/negatives, with bids/budgets/names).
2. **Types stay package-local**: define `CampaignPlan` etc. inside `packages/campaigns` — NOT
   in `packages/shared` (contract stays frozen; promotion to shared happens with 14b under
   manager sign-off).
3. **Exports**: (a) bulk-upload XLSX matching the existing builder's create output (paused by
   default — same safety posture), (b) plan JSON. Column/format parity with
   bulksheets-2.0-reference.md.
4. **Parity harness**: `~/os/amazon-agent/tools/amazon-campaign-builder/selftest.py` (678L) is
   ground truth — extend `fixtures/generate/` with a generator that runs its scenarios
   (synthetic data only) and dumps goldens; Vitest replays them against the TS port (same
   pattern as WP-05; read `fixtures/generate/generate_goldens.py` for the established
   conventions).
5. UI is NOT in 14a (lands with WP-07's surface later); a small CLI demo
   (`packages/campaigns/scripts/demo.ts` printing a plan from a fixture) is enough to show it
   works end to end.

## 14b (later, gate: manager opens after OAuth + entity sync live)

API create path: CampaignPlan → SP campaign/ad-group/keyword/negative create calls (WP-02
client write endpoints), paused by default, executed as an apply_batch (audit + revert =
archive), duplicate-skip against the entity mirror, per-plan operator approval. Harvesting's
destination auto-creation (WP-12) reuses this.

## Acceptance checks (14a)

- Parity suite green: TS plans byte-equal (name-for-name, bid-for-bid) to the Python
  selftest goldens for every create-mode scenario.
- Generated XLSX passes a structural diff against a Python-generated reference workbook for
  the same fixture (sheet names, headers, row values).
- Property tests: names always match the naming convention grammar; no duplicate keyword
  (text, match) within a campaign; bids within strategy caps; paused state everywhere.
- `packages/campaigns` imports only shared + strategy (purity test like core's).
- Branch `wp-14a-campaign-gen`; report per acceptance check; ambiguity table for any Python
  behavior you had to interpret.
