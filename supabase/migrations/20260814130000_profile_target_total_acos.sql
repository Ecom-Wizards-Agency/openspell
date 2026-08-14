-- wizard-ads 0016: ad_profiles.target_total_acos.
--
-- The plan's per-profile targets are target ACOS, target TOTAL ACOS, goal
-- lens and monthly budget (docs/PLAN.md "v1 module scope" item 2). The
-- total-ACOS column was missed in 0002 and surfaced by WP-04, whose settings
-- UI edits it. Additive only.

alter table public.ad_profiles
  add column if not exists target_total_acos numeric(6, 4);

comment on column public.ad_profiles.target_total_acos is
  'Target TACOS at profile level. Advisory until SP-API total sales land; the UI edits it now so doctrine is captured early.';
