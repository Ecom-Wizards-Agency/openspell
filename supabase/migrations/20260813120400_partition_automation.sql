-- wizard-ads 0005: partition automation.
--
-- Three functions, driven entirely by `app.fact_partitions`:
--
--   ensure_fact_partitions      pre-create the months ahead (and any month a
--                               backfill is about to write into)
--   rollup_fact_month           aggregate one month of one fact table into
--                               fact_monthly_rollup
--   drop_expired_fact_partitions  roll up, then drop, anything past retention
--
-- They are separate because dropping data is not something a cron job should
-- do as a side effect of creating partitions. The pre-create runs nightly; the
-- retention pass runs weekly and can be dry-run first.
--
-- A partition is named `<table>_YYYY_MM` and the month is read back out of that
-- name. The convention is the schema: everything that creates a partition here
-- goes through `app.fact_partition_name`.

create or replace function app.fact_partition_name(p_table text, p_month date)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_table || '_' || to_char(date_trunc('month', p_month), 'YYYY_MM');
$$;

-- Every partition currently attached to a managed fact table, with the month
-- decoded from its name. The ops view and the retention pass read the same
-- thing, so a partition the automation cannot see is a partition it cannot
-- silently mismanage either.
create or replace view app.fact_partition_status as
  select
    parent.relname::text as table_name,
    child.relname::text as partition_name,
    to_date(substring(child.relname from '(\d{4}_\d{2})$'), 'YYYY_MM') as month,
    pg_catalog.pg_total_relation_size(child.oid) as bytes
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class parent on parent.oid = i.inhparent
  join pg_catalog.pg_class child on child.oid = i.inhrelid
  join pg_catalog.pg_namespace n on n.oid = parent.relnamespace
  where n.nspname = 'public'
    and parent.relname in (select table_name from app.fact_partitions);

comment on view app.fact_partition_status is
  'Attached partitions of every managed fact table, with the month decoded from the partition name.';

-- ---------------------------------------------------------------------------
-- Pre-create
-- ---------------------------------------------------------------------------

create or replace function app.ensure_fact_partitions(
  p_from date default current_date,
  p_months integer default 2
)
returns table (table_name text, partition_name text, month date, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reg record;
  v_month date;
  v_name text;
  v_exists boolean;
begin
  perform app.assert_service_role('ensure_fact_partitions');

  for v_reg in select * from app.fact_partitions order by fact_partitions.table_name loop
    for v_offset in 0 .. greatest(p_months, 0) loop
      v_month := (date_trunc('month', p_from) + make_interval(months => v_offset))::date;
      v_name := app.fact_partition_name(v_reg.table_name, v_month);

      select exists (
        select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = v_name
      ) into v_exists;

      if not v_exists then
        execute format(
          'create table public.%I partition of public.%I for values from (%L) to (%L)',
          v_name, v_reg.table_name, v_month, (v_month + interval '1 month')::date
        );

        -- A partition is reachable by name, and Supabase's default privileges
        -- grant every new public table to anon and authenticated. Queries
        -- through the parent are governed by the parent's policies; a query
        -- naming the partition directly would otherwise be governed by nothing
        -- at all. So: no grants, and RLS on with no policies, which denies
        -- everyone but the owner and the service role.
        execute format('alter table public.%I enable row level security', v_name);
        execute format('revoke all on public.%I from anon, authenticated', v_name);
        execute format('grant all on public.%I to service_role', v_name);
      end if;

      table_name := v_reg.table_name;
      partition_name := v_name;
      month := v_month;
      created := not v_exists;
      return next;
    end loop;
  end loop;
end;
$$;

comment on function app.ensure_fact_partitions(date, integer) is
  'Create the monthly partitions covering [p_from, p_from + p_months]. Idempotent; also how a backfill opens historical months.';

-- ---------------------------------------------------------------------------
-- Rollup
-- ---------------------------------------------------------------------------

create or replace function app.rollup_fact_month(p_table text, p_month date)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reg app.fact_partitions%rowtype;
  v_month date := date_trunc('month', p_month)::date;
  v_dims text;
  v_group text;
  v_cols text := '';
  v_vals text := '';
  v_update text := '';
  v_metric text;
  v_rows bigint;
begin
  perform app.assert_service_role('rollup_fact_month');

  select * into v_reg from app.fact_partitions where fact_partitions.table_name = p_table;
  if not found then
    raise exception 'unknown fact table %', p_table using errcode = '22023';
  end if;
  if v_reg.rollup_source is null then
    return 0;
  end if;

  -- Dimensions become one jsonb object; every value is cast to text so the
  -- shape is stable no matter what type the source column has.
  if coalesce(array_length(v_reg.rollup_dimensions, 1), 0) = 0 then
    v_dims := '''{}''::jsonb';
    v_group := '';
  else
    select
      'jsonb_build_object(' || string_agg(format('%L, %I::text', d, d), ', ') || ')',
      ', ' || string_agg(format('%I', d), ', ')
    into v_dims, v_group
    from unnest(v_reg.rollup_dimensions) as d;
  end if;

  foreach v_metric in array v_reg.rollup_metrics loop
    v_cols := v_cols || format(', %I', v_metric);
    v_vals := v_vals || format(', sum(%I)', v_metric);
    v_update := v_update || format(', %I = excluded.%I', v_metric, v_metric);
  end loop;

  execute format(
    'insert into public.fact_monthly_rollup (org_id, profile_id, month, source, dimensions, days%s)
     select org_id, profile_id, %L::date, %L, %s, count(distinct %I)%s
     from public.%I
     where %I >= %L::date and %I < (%L::date + interval ''1 month'')
     group by org_id, profile_id%s
     on conflict (profile_id, month, source, dimensions) do update
       set days = excluded.days, org_id = excluded.org_id, rolled_up_at = now()%s',
    v_cols,
    v_month, v_reg.rollup_source, v_dims, v_reg.date_column, v_vals,
    p_table,
    v_reg.date_column, v_month, v_reg.date_column, v_month,
    v_group,
    v_update
  );

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function app.rollup_fact_month(text, date) is
  'Aggregate one month of one fact table into fact_monthly_rollup. Idempotent: re-running overwrites the same rows.';

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

create or replace function app.drop_expired_fact_partitions(
  p_today date default current_date,
  p_dry_run boolean default false
)
returns table (
  table_name text,
  partition_name text,
  month date,
  rows_rolled_up bigint,
  dropped boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_reg record;
  v_part record;
  v_keep_from date;
begin
  perform app.assert_service_role('drop_expired_fact_partitions');

  for v_reg in select * from app.fact_partitions order by fact_partitions.table_name loop
    -- retention_months counts the current month, so 26 keeps this month plus
    -- the 25 before it.
    v_keep_from := (date_trunc('month', p_today)
      - make_interval(months => v_reg.retention_months - 1))::date;

    for v_part in
      select s.partition_name, s.month
      from app.fact_partition_status s
      where s.table_name = v_reg.table_name
        and s.month is not null
        and s.month < v_keep_from
      order by s.month
    loop
      rows_rolled_up := 0;
      if not p_dry_run then
        rows_rolled_up := app.rollup_fact_month(v_reg.table_name, v_part.month);
        execute format('drop table public.%I', v_part.partition_name);
      end if;

      table_name := v_reg.table_name;
      partition_name := v_part.partition_name;
      month := v_part.month;
      dropped := not p_dry_run;
      return next;
    end loop;
  end loop;
end;
$$;

comment on function app.drop_expired_fact_partitions(date, boolean) is
  'Roll up then drop every partition older than its table''s retention. p_dry_run reports what would go without touching anything.';

revoke all on function app.ensure_fact_partitions(date, integer) from public;
revoke all on function app.rollup_fact_month(text, date) from public;
revoke all on function app.drop_expired_fact_partitions(date, boolean) from public;
grant execute on function app.ensure_fact_partitions(date, integer) to service_role;
grant execute on function app.rollup_fact_month(text, date) to service_role;
grant execute on function app.drop_expired_fact_partitions(date, boolean) to service_role;

-- The months the schema opens with. A migration that leaves a fact table
-- without a partition for today is a migration that breaks the first insert.
select app.ensure_fact_partitions(current_date, 2);
