-- ---------------------------------------------------------------------------
-- sync_schedules: one profile needs two report schedules of the same type
-- ---------------------------------------------------------------------------
--
-- `sync_schedules_scope_key` was unique on (profile_id, job_type, report_type).
-- That reads as "one schedule per thing to sync", which is one schedule too
-- few: WP-03's default cadences give every profile a *daily* re-pull of the
-- trailing 3 days and a *weekly* re-pull of the trailing 35 days, because
-- Amazon restates sales for 14+ days after the fact. Both rows are
-- job_type = 'report.request' with the same report_type and differ only in
-- cadence and lookback_days, so the old key made the pair unrepresentable and
-- the restatement pass could not be scheduled at all.
--
-- `variant` names which of a profile's schedules for one report type a row is.
-- 'default' is the daily recent-window pass; 'restatement' is the slower,
-- longer-lookback re-pull. The column is free-form on purpose — a third
-- cadence (an hourly intraday pass, say) is a new value, not a new migration.
--
-- Additive: the column defaults, so every existing row becomes the 'default'
-- variant and keeps the uniqueness it had.

alter table public.sync_schedules
  add column if not exists variant text not null default 'default';

comment on column public.sync_schedules.variant is
  'Which schedule for this profile and report type: ''default'' is the daily recent window, ''restatement'' the slower long-lookback re-pull. Part of the uniqueness key.';

alter table public.sync_schedules
  add constraint sync_schedules_variant_not_blank check (length(btrim(variant)) > 0);

drop index if exists public.sync_schedules_scope_key;

create unique index sync_schedules_scope_key
  on public.sync_schedules (profile_id, job_type, report_type, variant) nulls not distinct;
