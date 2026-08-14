-- wizard-ads 0020: per-target daily bid series (the bid corridor).
--
-- WP-28 HANDOFF TO WP-01 — HOSTED-APPLY REQUIRED. Additive: one partitioned
-- fact table, its indexes, its RLS, and one registry row. Nothing existing is
-- altered, so WP-01 should review this file rather than rewrite it, and the
-- manager must run it through the hosted-apply against the live database. The
-- implementer applied it only to a local throwaway test database.
--
-- What this stores, and why it is a table nothing else already is
-- (`tools/recon/04-optimizer.md` §3 "Bid corridor", §7 beat #7, §8 gap #3):
--
-- The bid corridor is Amazon's own daily suggested-bid low/median/high for one
-- target, drawn as a filled band, with the target's bid, its realized CPC and
-- its max-potential CPC plotted inside it. It is market evidence, retrieved and
-- retained per day — NOT anything the engine computes. A recommendation carries
-- one scalar per entity per run; the corridor is a time series, so it needs its
-- own daily grain. This is the WP-sync-and-schema surface the recon scoped as a
-- separate item, and this table is it.
--
-- Modelled on the fact tables (`20260813120300_facts.sql`): one profile, one
-- day, one target; a declarative monthly range partition on `date`; a BRIN on
-- date and a btree on (profile_id, date); RLS via `app.install_tenant_rls`
-- (members read, only the service role writes); and a row in
-- `app.fact_partitions` so the same pre-create and retention automation manages
-- it. `rollup_source` is null — a suggested-bid band is not a summable quantity,
-- so an expired partition is dropped without a monthly rollup, exactly the
-- "drop without rolling up" case the registry documents.

create table public.bid_series_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  campaign_id text not null,
  ad_group_id text not null,
  target_id text not null,
  -- A keyword or a product target. Both live in one series because the corridor
  -- is drawn the same way for either, and the drill-down does not care which.
  is_keyword boolean not null,
  -- Amazon's suggested-bid corridor for the day. Nullable as a set: Amazon can
  -- return an error for one id in a batch while answering the rest, and a day
  -- with no suggestion is a real (empty) day, not a missing row.
  suggested_bid_low numeric(12, 4),
  suggested_bid_median numeric(12, 4),
  suggested_bid_high numeric(12, 4),
  -- The bid in force that day. A step function: it only moves when moved.
  bid numeric(12, 4),
  -- Realized cost per click that day (cost / clicks over the target's facts).
  cpc numeric(12, 4),
  -- base bid x combined placement/dayparting modifier multiplier: the most a
  -- single click can cost. Composed by packages/core bidding `maxPotentialCpc`.
  max_potential_cpc numeric(12, 4),
  -- The modifier components that composed `max_potential_cpc`, in application
  -- order: `[{ "name": "top_of_search", "pct": 50 }, ...]`. jsonb because the
  -- corridor tooltip reads the whole set at once and never queries across it.
  modifier_components jsonb not null default '[]'::jsonb,
  -- When this day's series row was last synced. The provenance a stale-series
  -- check reads, the same role `loaded_at` plays on the fact tables.
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date, campaign_id, ad_group_id, target_id)
) partition by range (date);

comment on table public.bid_series_daily is
  'Per-target daily bid corridor: Amazon suggested-bid low/median/high, the bid in force, realized CPC, and max-potential CPC with its modifier components. Market evidence synced daily, not an engine output.';

create index bid_series_daily_date_brin on public.bid_series_daily using brin (date);
create index bid_series_daily_profile_date on public.bid_series_daily (profile_id, date);
create index bid_series_daily_org_date on public.bid_series_daily (org_id, date);
-- The drill-down reads one target's whole history: (profile, target, date).
create index bid_series_daily_target on public.bid_series_daily (profile_id, target_id, date);

-- Members read; only the service role writes a series row. Same posture as the
-- fact tables — the worker's sync fills it, nobody edits it by hand.
select app.install_tenant_rls('public.bid_series_daily');

-- Register it so the pre-create and retention automation manages its monthly
-- partitions. 26 months to match the daily facts. rollup_source null: the band
-- is not summable, so an expired partition drops without a monthly rollup.
insert into app.fact_partitions
  (table_name, date_column, retention_months, rollup_source, rollup_dimensions, rollup_metrics)
values
  ('bid_series_daily', 'date', 26, null, array[]::text[], array[]::text[]);

-- Open this table's partitions for the current window; a fact table with no
-- partition for today breaks its first insert. Idempotent across every
-- registered table, so re-opening the others' partitions is a no-op.
select app.ensure_fact_partitions(current_date, 2);
