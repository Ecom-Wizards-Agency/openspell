-- TEST FIXTURE. Not a migration.
--
-- `app.seed_tenant_fixture` writes exactly one row into every tenant table for
-- one org. The RLS suite calls it twice, for two orgs, and then asserts that a
-- member of one sees their row and none of the other's, table by table, walking
-- the catalog rather than a hand-kept list.
--
-- That is why this function inserts into *every* table rather than a
-- representative sample: the RLS test first checks that both orgs have a row in
-- every tenant table, so a table added later without a fixture row fails the
-- suite instead of passing it vacuously.

create or replace function app.seed_tenant_fixture(
  p_slug text,
  p_user_id uuid,
  p_role public.org_role default 'analyst',
  p_date date default current_date
)
returns uuid
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_org uuid;
  v_conn uuid;
  v_profile uuid;
  v_run uuid;
  v_batch uuid;
  v_tag uuid;
  v_feedback uuid;
  v_experiment uuid;
  v_asset uuid;
  v_spapi uuid;
  v_report uuid;
  v_recommendation uuid;
  v_group uuid;
  v_strategy jsonb := jsonb_build_object(
    'schema', 'wizard-ads.tenant-strategy.v1',
    'pacing', '{}'::jsonb,
    'opt_groups', '{}'::jsonb,
    'rank_lifecycle', '{}'::jsonb,
    'staged_apply', '{}'::jsonb,
    'bids', '{}'::jsonb,
    'sv_bands', '{}'::jsonb,
    'caps', '{}'::jsonb,
    'pat_split', '{}'::jsonb,
    'naming', '{}'::jsonb
  );
begin
  perform public.auth_user_stub(p_user_id);

  insert into public.orgs (slug, name) values (p_slug, initcap(p_slug)) returning id into v_org;
  insert into public.org_members (org_id, user_id, role) values (v_org, p_user_id, p_role);

  insert into public.org_invitations
    (org_id, email, role, token_prefix, token_hash, invited_by, expires_at)
  values
    (v_org, p_slug || '-invite@example.test', 'viewer',
     substring(md5(p_slug || '-invite') || md5(p_slug || '-invite-2') for 12),
     md5(p_slug || '-invite') || md5(p_slug || '-invite-2'), p_user_id,
     now() + interval '7 days');

  insert into public.ads_connections (org_id, label, status)
  values (v_org, p_slug || '-ads', 'active') returning id into v_conn;

  insert into public.integration_connections (org_id, provider, label, connected_by)
  values (v_org, 'keepa', p_slug || '-integration', p_user_id);

  insert into public.ad_profiles
    (org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
  values
    (v_org, v_conn, p_slug || '-profile-1', 'NA', 'US', 'USD', 'UTC', true)
  returning id into v_profile;

  insert into public.profile_strategy (org_id, profile_id, schema_version, doc)
  values (v_org, null, 'wizard-ads.tenant-strategy.v1', v_strategy);

  -- Entity mirror
  insert into public.portfolios (org_id, profile_id, amazon_id, ad_product, name, state)
  values (v_org, v_profile, 'pf-1', 'SP', 'portfolio', 'enabled');
  insert into public.campaigns
    (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
  values (v_org, v_profile, 'c-1', 'SP', 'campaign', 'enabled', 10.00, 'daily');
  insert into public.ad_groups
    (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
  values (v_org, v_profile, 'ag-1', 'SP', 'ad group', 'enabled', 'c-1', 0.75);
  insert into public.product_ads
    (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, asin)
  values (v_org, v_profile, 'pa-1', 'SP', 'enabled', 'c-1', 'ag-1', 'B0TEST0001');
  insert into public.keywords
    (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
  values (v_org, v_profile, 'kw-1', 'SP', 'enabled', 'c-1', 'ag-1', 'widget', 'exact', 0.90);
  insert into public.targets
    (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, expression, bid)
  values (v_org, v_profile, 'tg-1', 'SP', 'enabled', 'c-1', 'ag-1',
          '[{"type":"asin_same_as","value":"B0TEST0002"}]'::jsonb, 0.60);
  insert into public.negatives
    (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, scope, keyword_text, match_type)
  values (v_org, v_profile, 'ng-1', 'SP', 'enabled', 'c-1', 'ag-1', 'ad_group', 'free widget', 'negative_exact');
  insert into public.entity_changes
    (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value, source)
  values (v_org, v_profile, 'keyword', 'kw-1', 'bid', '0.80'::jsonb, '0.90'::jsonb, 'sync');

  -- Facts
  insert into public.fact_sp_target_daily
    (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
     match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
  values (v_org, v_profile, p_date, 'SP', 'c-1', 'ag-1', 'kw-1', 'keyword',
          'exact', 100, 5, 4.50, 1, 25.00, 1);
  insert into public.fact_search_term_daily
    (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
     match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
  values (v_org, v_profile, p_date, 'SP', 'c-1', 'ag-1', 'kw-1', 'blue widget',
          'exact', 80, 3, 2.70, 1, 25.00, 1);
  insert into public.fact_placement_daily
    (org_id, profile_id, date, ad_product, campaign_id, placement, impressions, clicks, cost,
     purchases_7d, sales_7d)
  values (v_org, v_profile, p_date, 'SP', 'c-1', 'top_of_search', 60, 4, 3.60, 1, 25.00);
  insert into public.fact_sb_daily
    (org_id, profile_id, date, campaign_id, impressions, clicks, cost, purchases_7d, sales_7d)
  values (v_org, v_profile, p_date, 'sb-1', 40, 2, 1.80, 0, 0);
  insert into public.fact_sd_daily
    (org_id, profile_id, date, campaign_id, impressions, clicks, cost, purchases_7d, sales_7d)
  values (v_org, v_profile, p_date, 'sd-1', 30, 1, 0.90, 0, 0);
  insert into public.fact_profile_daily
    (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d, sales_7d,
     units_sold_7d, provisional)
  values (v_org, v_profile, p_date, 'USD', 230, 12, 10.80, 2, 50.00, 2, false);
  insert into public.fact_monthly_rollup
    (org_id, profile_id, month, source, dimensions, days, impressions, clicks, cost)
  values (v_org, v_profile, date_trunc('month', p_date)::date, 'sp_target', '{}'::jsonb, 1, 100, 5, 4.50);
  insert into public.product_economics
    (org_id, profile_id, asin, captured_on, sale_price, cogs, fba_fees,
     referral_fees, other_fees, margin, ltv_revenue, ltv_orders, repeat_rate, currency)
  values (v_org, v_profile, 'B0TEST0001', p_date, 25.00, 7.00, 4.00,
          3.75, 1.00, 9.25, 42.00, 1.40, 0.18, 'USD');
  -- The bid corridor (WP-28): one target's suggested-bid band for the day, with
  -- the bid, realized CPC and max-potential CPC and its modifier components.
  insert into public.bid_series_daily
    (org_id, profile_id, date, campaign_id, ad_group_id, target_id, is_keyword,
     suggested_bid_low, suggested_bid_median, suggested_bid_high, bid, cpc, max_potential_cpc,
     modifier_components)
  values (v_org, v_profile, p_date, 'c-1', 'ag-1', 'kw-1', true,
          0.50, 0.80, 1.20, 0.90, 1.10, 1.35,
          '[{"name": "top_of_search", "pct": 50}]'::jsonb);

  -- Sync
  insert into public.sync_schedules (org_id, profile_id, job_type, cadence, lookback_days)
  values (v_org, v_profile, 'entity.sync', interval '1 day', null);
  insert into public.sync_jobs (org_id, profile_id, job_type, payload)
  values (v_org, v_profile, 'entity.sync',
          jsonb_build_object('type', 'entity.sync', 'orgId', v_org, 'profileId', v_profile, 'full', false));
  insert into public.report_requests
    (org_id, profile_id, report_type, start_date, end_date, status, rows_parsed, rows_loaded)
  values (v_org, v_profile, 'spCampaigns', p_date - 1, p_date, 'completed', 10, 10)
  returning id into v_report;

  -- Analysis
  insert into public.recommendation_runs (org_id, profile_id, status, lookback_days)
  values (v_org, v_profile, 'succeeded', 30) returning id into v_run;
  insert into public.recommendations
    (run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs)
  values (v_run, v_org, v_profile, 'high_acos', 'keyword', 'kw-1', 'bid', '0.90'::jsonb, '0.70'::jsonb,
          jsonb_build_object('rpc', 5.0, 'clicks', 5, 'cvrSourceLevel', 'keyword',
                             'ceilingApplied', null, 'capClamped', false))
  returning id into v_recommendation;
  insert into public.insights (org_id, profile_id, date, kind, title, body)
  values (v_org, v_profile, p_date, 'daily', 'synthetic insight', 'body');
  insert into public.crosscheck_results
    (org_id, profile_id, date, grain, metric, ours, theirs, delta_pct, tolerance, verdict)
  values (v_org, v_profile, p_date, 'profile', 'cost', 10.80, 10.80, 0, 0.07, 'verified');

  -- Writes
  insert into public.apply_batches
    (org_id, profile_id, tag, opt_group, lever, note, status, applied_on,
     exported_proposals, reversible_rows, unsupported_rows)
  values (v_org, v_profile, p_slug || '-2026W33-rank-bid-down', 'rank', 'bid-down',
          'synthetic', 'applied', p_date, 1, 1, 0)
  returning id into v_batch;
  insert into public.apply_rows
    (batch_id, org_id, profile_id, entity_type, entity_id, entity_name, field,
     old_value, new_value, lever, clicks, revenue)
  values (v_batch, v_org, v_profile, 'keyword', 'kw-1', 'widget', 'bid',
          '0.90'::jsonb, '0.70'::jsonb, 'bid-down', 5, 25.00);
  insert into public.campaign_maps (org_id, profile_id, name)
  values (v_org, v_profile, 'harvest map');

  -- Product surface
  insert into public.tags (org_id, name, slug) values (v_org, 'Client', 'client') returning id into v_tag;
  insert into public.entity_tags (tag_id, org_id, profile_id, entity_type, entity_id)
  values (v_tag, v_org, v_profile, 'campaign', 'c-1');
  insert into public.dashboards (org_id, name) values (v_org, 'Overview');
  insert into public.goto_links (org_id, token, route)
  values (v_org, p_slug || '-token', '/grid');
  insert into public.audit_log (org_id, actor_type, action)
  values (v_org, 'service', 'fixture.seed');

  -- Feedback: one item and the author's own vote on it, so the RLS walk has a
  -- row in both feedback tables for every org it seeds.
  insert into public.feedback_items (org_id, author_id, type, title, body, severity, page_context)
  values (v_org, p_user_id, 'bug', 'Fixture bug report', 'Seeded by the tenant fixture.', 'low',
          jsonb_build_object('route', '/settings/profiles', 'actorType', 'fixture'))
  returning id into v_feedback;
  insert into public.feedback_votes (item_id, org_id, user_id) values (v_feedback, v_org, p_user_id);

  -- Experiments: one running experiment scoped to the seeded campaign, and its
  -- creation event, so the RLS walk has a row in both experiment tables for
  -- every org it seeds.
  insert into public.experiments
    (org_id, profile_id, name, hypothesis, type, scope, metric_focus, start_at, status, created_by)
  values (v_org, v_profile, 'Fixture bid push', 'Pushing bids should lift sales.', 'bid_push',
          jsonb_build_object('campaignIds', jsonb_build_array('c-1'), 'targetIds', jsonb_build_array('kw-1')),
          'sales', now() - interval '7 days', 'running', p_user_id)
  returning id into v_experiment;
  insert into public.experiment_events (experiment_id, org_id, from_status, to_status, note, actor_id)
  values (v_experiment, v_org, null, 'running', 'Seeded by the tenant fixture.', p_user_id);

  -- Reserved seams
  insert into public.spapi_connections
    (org_id, label, selling_partner_id, marketplace_ids)
  values
    (v_org, p_slug || '-spapi', p_slug || '-seller', array['ATVPDKIKX0DER'])
  returning id into v_spapi;
  insert into public.spapi_profile_bindings
    (org_id, profile_id, connection_id, marketplace_id)
  values (v_org, v_profile, v_spapi, 'ATVPDKIKX0DER');
  insert into public.fact_sales_traffic_daily (org_id, profile_id, date, asin, sessions)
  values (v_org, v_profile, p_date, 'B0TEST0001', 10);
  insert into public.fact_sqp_weekly (org_id, profile_id, week_start, asin, search_query, search_volume)
  values (v_org, v_profile, p_date - extract(dow from p_date)::integer, 'B0TEST0001', 'blue widget', 1000);
  insert into public.supa_flags (org_id, profile_id, week_start, asin, search_query, rule)
  values (v_org, v_profile, p_date - extract(dow from p_date)::integer, 'B0TEST0001', 'blue widget', 'P3');
  insert into public.rank_observations (org_id, profile_id, asin, keyword, observed_on, organic_rank)
  values (v_org, v_profile, 'B0TEST0001', 'blue widget', p_date, 12);
  insert into public.keepa_bsr_observations (org_id, asin, observed_at, category, bsr)
  values (v_org, 'B0TEST0001', now(), 'Widgets', 4200);
  insert into public.competitor_links (org_id, profile_id, our_asin, competitor_asin)
  values (v_org, v_profile, 'B0TEST0001', 'B0TEST0002');
  insert into public.competitor_price_events
    (org_id, asin, event_kind, detected_at, price, baseline_price)
  values (v_org, 'B0TEST0002', 'deal_start', now(), 19.99, 24.99);
  insert into public.creative_assets (org_id, profile_id, kind, content_hash)
  values (v_org, v_profile, 'video', p_slug || '-hash-1') returning id into v_asset;
  insert into public.creative_placements (org_id, asset_id, profile_id, campaign_id)
  values (v_org, v_asset, v_profile, 'c-1');

  -- Operator-intelligence foundations (WP-56)
  insert into public.report_coverage
    (org_id, profile_id, report_type, grain, source, status,
     earliest_requested_date, earliest_returned_date, latest_loaded_date)
  values (v_org, v_profile, 'spCampaigns', 'daily', 'amazon_reporting_v3', 'complete',
          p_date - 1, p_date - 1, p_date);

  insert into public.historical_bootstrap_progress
    (org_id, profile_id, report_type, grain, source, status,
     requested_start_date, requested_end_date, chunks_planned, chunks_completed)
  values (v_org, v_profile, 'spCampaigns', 'daily', 'amazon_reporting_v3', 'complete',
          p_date - 1, p_date, 1, 1);

  insert into public.report_promotion_watermarks
    (org_id, profile_id, report_type, report_date, source, report_request_id,
     requested_at, source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows)
  values (v_org, v_profile, 'spCampaigns', p_date, 'amazon_reporting_v3', v_report,
          now(), 1, 1, 0, 1, 1);

  insert into public.attribution_observations
    (org_id, profile_id, source_observation_key, event_date, ad_product,
     report_type, source, observed_at, attribution_window_days, event_date_age_days,
     impressions, clicks, cost, purchases, sales)
  values (v_org, v_profile, p_slug || '-attribution-1', p_date, 'SP',
          'spCampaigns', 'amazon_reporting_v3', now(), 14, 1,
          100, 5, 4.5, 1, 25);

  insert into public.ad_creative_asset_mappings
    (org_id, profile_id, source_mapping_key, ad_product, campaign_id,
     ad_group_id, ad_id, creative_asset_id, attribution_state, observed_at)
  values (v_org, v_profile, p_slug || '-mapping-1', 'SB', 'sb-1',
          'sb-ag-1', 'sb-ad-1', v_asset, 'legacy', now());

  insert into public.fact_creative_daily
    (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, ad_id,
     attribution_state, impressions, clicks, cost, purchases, sales)
  values (v_org, v_profile, p_date, 'SB', 'sb-1', 'sb-ag-1', 'sb-ad-1',
          'legacy', 40, 2, 1.8, 0, 0);

  insert into public.sqp_promotion_runs
    (org_id, profile_id, marketplace_id, week_start, source_system,
     request_identity, requested_at, completed_at, requested_asins,
     source_reports, input_fingerprint, source_asins, source_rows, parsed_rows,
     deduplicated_rows, refused_rows, promoted_rows, canonical_rows)
  values
    (v_org, v_profile, p_slug || '-market',
     p_date - extract(dow from p_date)::integer,
     'amazon_sp_api_brand_analytics', p_slug || '-sqp-promotion',
     now() - interval '1 minute', now(), array['B0TEST0001'],
     jsonb_build_array(jsonb_build_object(
       'requestKey', p_slug || '-sqp-request',
       'reportId', p_slug || '-sqp-report',
       'reportDocumentId', null,
       'requestedAt', to_jsonb(now() - interval '1 minute'),
       'completedAt', to_jsonb(now()),
       'providerCreatedAt', null,
       'requestedAsins', jsonb_build_array('B0TEST0001')
     )), md5(p_slug || '-sqp-input'), 0, 0, 0, 0, 0, 0, 0);

  insert into public.query_vocabulary
    (org_id, marketplace_id, kind, value, normalized_value, source, approved,
     reviewed_at, reviewed_by)
  values (v_org, p_slug || '-market', 'core_term', 'fixture term', 'fixture term',
          'operator', true, now(), p_user_id);

  insert into public.contextual_negative_proposals
    (org_id, profile_id, marketplace_id, campaign_id, ad_group_id, search_term,
     normalized_query, category, source_group_role, match_type, reason)
  values (v_org, v_profile, p_slug || '-market', 'c-1', 'ag-1', 'fixture excluded',
          'fixture excluded', 'excluded', 'discovery', 'negative_exact', 'fixture');

  insert into public.optimization_groups
    (org_id, profile_id, name, role, target_acos,
     bid_increase_cap, bid_decrease_cap, placement_increase_cap,
     placement_decrease_cap, cadence, prioritization)
  values (v_org, v_profile, 'Fixture Group', 'rank', 0.2,
          0.1, 0.1, 0.1, 0.1, interval '1 day', 'balanced')
  returning id into v_group;

  insert into public.campaign_optimization_assignments
    (org_id, profile_id, campaign_id, group_id, assigned_by)
  values (v_org, v_profile, 'c-1', v_group, p_user_id);

  insert into public.recommendation_observations
    (org_id, profile_id, recommendation_id, group_id, expected_value,
     observation_window_start, observation_window_end, evidence_state,
     decision, evidence_note)
  values (v_org, v_profile, v_recommendation, v_group, 0.7,
          p_date - 7, p_date, 'insufficient', 'hold', 'fixture');

  insert into public.marketing_stream_events
    (org_id, profile_id, message_id, dataset, ad_product, event_time,
     received_at, revision, payload_hash, raw_payload)
  values (v_org, v_profile, p_slug || '-stream-1', 'traffic', 'SP',
          date_trunc('hour', now()), now(), 0, p_slug || '-payload-1', '{}'::jsonb);

  insert into public.marketing_stream_hourly_facts
    (org_id, profile_id, ad_product, campaign_id, utc_hour, profile_timezone,
     local_date, local_hour, local_day_of_week, currency_code, impressions,
     clicks, settling_state, source_events)
  values (v_org, v_profile, 'SP', 'c-1', date_trunc('hour', now()), 'UTC',
          current_date, extract(hour from now())::integer,
          extract(dow from current_date)::integer, 'USD', 10, 1, 'settling', 1);

  insert into public.dayparting_schedule_proposals
    (org_id, profile_id, campaign_id, baseline_label, evidence_start,
     evidence_end, settled_hours, blocks)
  values (v_org, v_profile, 'c-1', 'fixture baseline', p_date - 7, p_date,
          24, '[]'::jsonb);

  return v_org;
end;
$$;

-- A user row the fixture can point at, created only when the auth schema is the
-- shim's (a real Supabase project has its own users and its own admin API).
create or replace function public.auth_user_stub(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  insert into auth.users (id) values (p_user_id) on conflict (id) do nothing;
end;
$$;
