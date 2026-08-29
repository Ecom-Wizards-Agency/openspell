-- WP-85: read-only Sponsored Brands Video observed-attribution ingestion.
--
-- A current SB ad listing proves only what was observed now. It does not prove
-- that the same Asset ID was attached on a historical report date, so every
-- promoted row carries explicit current-snapshot provenance and promotion is
-- separately gated by the worker.

create table public.creative_sync_snapshots (
  id uuid primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null,
  start_date date not null,
  end_date date not null,
  observed_at timestamptz not null,
  mapping_provenance text not null,
  historical_validity text not null,
  status text not null,
  pagination_complete boolean not null,
  fact_promotion_allowed boolean not null,
  source_assets bigint not null,
  parsed_assets bigint not null,
  source_ads bigint not null,
  parsed_ads bigint not null,
  mapped bigint not null,
  legacy bigint not null,
  unsupported bigint not null,
  ambiguous bigint not null,
  unmapped bigint not null,
  report_source_rows bigint,
  report_parsed_rows bigint,
  report_refused_rows bigint,
  mapped_fact_rows bigint not null default 0,
  unpromoted_report_rows bigint not null default 0,
  assets_upserted bigint not null default 0,
  mappings_upserted bigint not null default 0,
  facts_upserted bigint not null default 0,
  assets_read_back bigint not null default 0,
  mappings_read_back bigint not null default 0,
  facts_read_back bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creative_sync_snapshots_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint creative_sync_snapshots_window check (end_date >= start_date),
  constraint creative_sync_snapshots_provenance check (
    mapping_provenance = 'current_sb_ad_snapshot'
    and historical_validity = 'unproven_current_snapshot'
  ),
  constraint creative_sync_snapshots_status check (
    status in ('mapping_only', 'report_pending', 'completed', 'blocked')
  ),
  constraint creative_sync_snapshots_counts_nonnegative check (
    source_assets >= 0 and parsed_assets >= 0
    and source_ads >= 0 and parsed_ads >= 0
    and mapped >= 0 and legacy >= 0 and unsupported >= 0
    and ambiguous >= 0 and unmapped >= 0
    and (report_source_rows is null or report_source_rows >= 0)
    and (report_parsed_rows is null or report_parsed_rows >= 0)
    and (report_refused_rows is null or report_refused_rows >= 0)
    and mapped_fact_rows >= 0 and unpromoted_report_rows >= 0
    and assets_upserted >= 0 and mappings_upserted >= 0 and facts_upserted >= 0
    and assets_read_back >= 0 and mappings_read_back >= 0 and facts_read_back >= 0
  ),
  constraint creative_sync_snapshots_parse_counts check (
    parsed_assets <= source_assets and parsed_ads <= source_ads
  ),
  constraint creative_sync_snapshots_coverage_counts check (
    parsed_ads = mapped + legacy + unsupported + ambiguous + unmapped
  ),
  constraint creative_sync_snapshots_report_counts check (
    (
      report_source_rows is null
      and report_parsed_rows is null
      and report_refused_rows is null
      and mapped_fact_rows = 0
      and unpromoted_report_rows = 0
    )
    or (
      report_source_rows is not null
      and report_parsed_rows is not null
      and report_refused_rows is not null
      and report_source_rows = report_parsed_rows + report_refused_rows
      and mapped_fact_rows + unpromoted_report_rows = report_parsed_rows
    )
  ),
  unique (org_id, profile_id, id)
);

create index creative_sync_snapshots_profile_observed_idx
  on public.creative_sync_snapshots (profile_id, observed_at desc);
create unique index creative_sync_snapshots_one_report_pending_idx
  on public.creative_sync_snapshots (org_id, profile_id)
  where status = 'report_pending';
select app.install_tenant_rls('public.creative_sync_snapshots');

alter table public.ad_creative_asset_mappings
  add column creative_version text,
  add column mapping_provenance text,
  add column creative_sync_snapshot_id uuid,
  add constraint ad_creative_asset_mappings_snapshot_fkey
    foreign key (org_id, profile_id, creative_sync_snapshot_id)
    references public.creative_sync_snapshots (org_id, profile_id, id) on delete restrict,
  add constraint ad_creative_asset_mappings_creative_version_nonempty
    check (creative_version is null or btrim(creative_version) <> ''),
  add constraint ad_creative_asset_mappings_mapping_provenance check (
    (mapping_provenance is null and creative_sync_snapshot_id is null)
    or (
      mapping_provenance = 'current_sb_ad_snapshot'
      and creative_sync_snapshot_id is not null
    )
  ),
  add constraint ad_creative_asset_mappings_mapped_creative_identity check (
    attribution_state <> 'mapped'
    or creative_id is not null
    or creative_version is not null
  );

alter table public.fact_creative_daily
  add column creative_version text,
  add column mapping_provenance text,
  add column creative_sync_snapshot_id uuid,
  add constraint fact_creative_daily_snapshot_fkey
    foreign key (org_id, profile_id, creative_sync_snapshot_id)
    references public.creative_sync_snapshots (org_id, profile_id, id) on delete restrict,
  add constraint fact_creative_daily_creative_version_nonempty
    check (creative_version is null or btrim(creative_version) <> ''),
  add constraint fact_creative_daily_mapping_provenance check (
    (mapping_provenance is null and creative_sync_snapshot_id is null)
    or (
      mapping_provenance = 'current_sb_ad_snapshot'
      and creative_sync_snapshot_id is not null
    )
  ),
  add constraint fact_creative_daily_mapped_creative_identity check (
    attribution_state <> 'mapped'
    or creative_id is not null
    or creative_version is not null
  );

drop index public.fact_creative_daily_grain_key;
create unique index fact_creative_daily_grain_key
  on public.fact_creative_daily
    (profile_id, date, ad_product, campaign_id, ad_group_id, ad_id,
     creative_id, creative_version, amazon_asset_id, placement)
  nulls not distinct;

alter table public.report_requests
  add column creative_sync_snapshot_id uuid,
  add column source_rows bigint,
  add column refused_rows bigint,
  add column promoted_rows bigint,
  add column unpromoted_rows bigint,
  add column accounting_complete boolean generated always as (
    case
      when source_rows is null
       and refused_rows is null
       and promoted_rows is null
       and unpromoted_rows is null then null
      else source_rows is not null
       and rows_parsed is not null
       and refused_rows is not null
       and promoted_rows is not null
       and unpromoted_rows is not null
       and rows_loaded is not null
       and source_rows = rows_parsed + refused_rows
       and rows_parsed = promoted_rows + unpromoted_rows
       and promoted_rows = rows_loaded
    end
  ) stored,
  add constraint report_requests_creative_snapshot_fkey
    foreign key (org_id, profile_id, creative_sync_snapshot_id)
    references public.creative_sync_snapshots (org_id, profile_id, id) on delete restrict,
  add constraint report_requests_creative_snapshot_scope check (
    creative_sync_snapshot_id is null or report_type = 'sbAds'
  ),
  add constraint report_requests_attribution_counts_nonnegative check (
    (source_rows is null or source_rows >= 0)
    and (refused_rows is null or refused_rows >= 0)
    and (promoted_rows is null or promoted_rows >= 0)
    and (unpromoted_rows is null or unpromoted_rows >= 0)
  );

create or replace function app.block_creative_snapshot_on_report_terminal()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.creative_sync_snapshot_id is not null
     and new.status in ('failed', 'cancelled', 'expired') then
    update public.creative_sync_snapshots
       set status = 'blocked'
     where id = new.creative_sync_snapshot_id
       and org_id = new.org_id
       and profile_id = new.profile_id
       and status = 'report_pending';
  end if;
  return new;
end;
$$;

create trigger report_requests_block_creative_snapshot
  after update of status on public.report_requests
  for each row execute function app.block_creative_snapshot_on_report_terminal();

create trigger creative_sync_snapshots_touch
  before update on public.creative_sync_snapshots
  for each row execute function app.touch_updated_at();

comment on table public.creative_sync_snapshots is
  'Counted current SB ad/asset observations. Provenance is intentionally non-historical until a separately authorized live probe proves time-valid mapping.';
comment on column public.fact_creative_daily.placement is
  'Null for sbAds: the ad-grain report does not report placement.';
comment on column public.report_requests.accounting_complete is
  'For attribution-aware reports: source = parsed + refused, parsed = promoted + unpromoted, and promoted = canonical rows_loaded. Null on legacy/base report accounting.';
