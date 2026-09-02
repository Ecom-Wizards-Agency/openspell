-- WP-192: private, token-fenced delivery custody for the immutable SP write outbox.
--
-- This migration adds no worker, job member, provider route, schedule, gate value,
-- seed, or deployment behavior. The immutable WP-187 outbox remains the source
-- wake; current delivery custody is private operational state in `app`.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);

-- -------------------------------------------------------------------------
-- Private current projection and immutable transition journal
-- -------------------------------------------------------------------------

create table app.sp_write_outbox_delivery_heads (
  org_id uuid not null,
  profile_id uuid not null,
  outbox_id uuid primary key,
  state text not null,
  claim_epoch bigint not null,
  transition_sequence bigint not null,
  claimant_id text,
  token_digest text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  available_at timestamptz,
  attempt_count bigint not null,
  completed_at timestamptz,
  constraint sp_write_outbox_delivery_heads_outbox_fkey
    foreign key (org_id, profile_id, outbox_id)
    references public.sp_write_outbox (org_id, profile_id, outbox_id)
    on delete cascade,
  constraint sp_write_outbox_delivery_heads_tenant_identity_key
    unique (org_id, profile_id, outbox_id),
  constraint sp_write_outbox_delivery_heads_counters_check check (
    claim_epoch >= 0
    and attempt_count = claim_epoch
    and transition_sequence >= claim_epoch
  ),
  constraint sp_write_outbox_delivery_heads_shape_check check (
    (
      state = 'available'
      and available_at is not null
      and claimant_id is null
      and token_digest is null
      and claimed_at is null
      and lease_expires_at is null
      and completed_at is null
    )
    or (
      state = 'leased'
      and available_at is null
      and claimant_id is not null
      and claimant_id = btrim(claimant_id)
      and claimant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      and token_digest is not null
      and token_digest ~ '^[a-f0-9]{64}$'
      and claimed_at is not null
      and lease_expires_at is not null
      and lease_expires_at > claimed_at
      and lease_expires_at <= claimed_at + interval '300 seconds'
      and completed_at is null
    )
    or (
      state = 'completed'
      and available_at is null
      and claimant_id is null
      and token_digest is null
      and claimed_at is null
      and lease_expires_at is null
      and completed_at is not null
    )
  )
);

create index sp_write_outbox_delivery_heads_available_idx
  on app.sp_write_outbox_delivery_heads (available_at, outbox_id)
  where state = 'available';

create index sp_write_outbox_delivery_heads_lease_expiry_idx
  on app.sp_write_outbox_delivery_heads (lease_expires_at, outbox_id)
  where state = 'leased';

create table app.sp_write_outbox_delivery_events (
  org_id uuid not null,
  profile_id uuid not null,
  outbox_id uuid not null,
  transition_sequence bigint not null,
  claim_epoch bigint not null,
  event_kind text not null,
  actor_claimant_id text not null,
  actor_token_digest text not null,
  recorded_at timestamptz not null,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  available_at timestamptz,
  completed_at timestamptz,
  defer_reason text,
  primary key (outbox_id, transition_sequence),
  constraint sp_write_outbox_delivery_events_head_fkey
    foreign key (org_id, profile_id, outbox_id)
    references app.sp_write_outbox_delivery_heads (org_id, profile_id, outbox_id)
    on delete cascade,
  constraint sp_write_outbox_delivery_events_identity_key
    unique (org_id, profile_id, outbox_id, transition_sequence),
  constraint sp_write_outbox_delivery_events_actor_check check (
    transition_sequence >= 1
    and claim_epoch >= 1
    and actor_claimant_id = btrim(actor_claimant_id)
    and actor_claimant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and actor_token_digest ~ '^[a-f0-9]{64}$'
  ),
  constraint sp_write_outbox_delivery_events_shape_check check (
    (
      event_kind in ('claimed', 'expired_reclaimed')
      and claimed_at is not null
      and lease_expires_at is not null
      and claimed_at = recorded_at
      and lease_expires_at > claimed_at
      and lease_expires_at <= claimed_at + interval '300 seconds'
      and available_at is null
      and completed_at is null
      and defer_reason is null
    )
    or (
      event_kind = 'renewed'
      and claimed_at is not null
      and lease_expires_at is not null
      and claimed_at <= recorded_at
      and lease_expires_at > recorded_at
      and lease_expires_at <= claimed_at + interval '300 seconds'
      and available_at is null
      and completed_at is null
      and defer_reason is null
    )
    or (
      event_kind = 'deferred'
      and claimed_at is null
      and lease_expires_at is null
      and available_at is not null
      and available_at > recorded_at
      and completed_at is null
      and defer_reason is not null
      and defer_reason in (
        'reservation_busy', 'observation_pending', 'recovery_pending', 'shutdown'
      )
    )
    or (
      event_kind = 'completed'
      and claimed_at is null
      and lease_expires_at is null
      and available_at is null
      and completed_at is not null
      and completed_at = recorded_at
      and defer_reason is null
    )
  )
);

-- -------------------------------------------------------------------------
-- Internal identity, genesis, eligibility, and closure helpers
-- -------------------------------------------------------------------------

create or replace function app.sp_write_outbox_claim_token_digest(p_token uuid)
returns text
language sql
immutable
strict
set search_path = pg_catalog, app, pg_temp
as $$
  select app.sp_write_sha256(
    'openspell.sp-write-outbox-claim-token.sql.v1' || chr(10) || lower(p_token::text)
  );
$$;

create or replace function app.sp_write_create_outbox_delivery_head()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_inserted integer;
begin
  insert into app.sp_write_outbox_delivery_heads (
    org_id, profile_id, outbox_id, state, claim_epoch, transition_sequence,
    claimant_id, token_digest, claimed_at, lease_expires_at, available_at,
    attempt_count, completed_at
  ) values (
    new.org_id, new.profile_id, new.outbox_id, 'available', 0, 0,
    null, null, null, null, new.created_at, 0, null
  );
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    raise exception 'SP write outbox delivery head creation count does not close'
      using errcode = 'P0003';
  end if;
  return new;
end;
$$;

create trigger sp_write_outbox_create_delivery_head
  after insert on public.sp_write_outbox
  for each row execute function app.sp_write_create_outbox_delivery_head();

insert into app.sp_write_outbox_delivery_heads (
  org_id, profile_id, outbox_id, state, claim_epoch, transition_sequence,
  claimant_id, token_digest, claimed_at, lease_expires_at, available_at,
  attempt_count, completed_at
)
select
  outbox.org_id, outbox.profile_id, outbox.outbox_id, 'available', 0, 0,
  null, null, null, null, outbox.created_at, 0, null
from public.sp_write_outbox outbox
order by outbox.created_at, outbox.outbox_id;

create or replace function app.sp_write_assert_outbox_delivery_backfill()
returns void
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outboxes bigint;
  v_heads bigint;
begin
  select count(*) into v_outboxes from public.sp_write_outbox;
  select count(*) into v_heads from app.sp_write_outbox_delivery_heads;
  if v_outboxes <> v_heads
     or exists (
       select 1
       from public.sp_write_outbox outbox
       left join app.sp_write_outbox_delivery_heads head
         on head.org_id = outbox.org_id
        and head.profile_id = outbox.profile_id
        and head.outbox_id = outbox.outbox_id
       where head.outbox_id is null
          or head.state <> 'available'
          or head.claim_epoch <> 0
          or head.transition_sequence <> 0
          or head.attempt_count <> 0
          or head.available_at is distinct from outbox.created_at
          or head.claimant_id is not null
          or head.token_digest is not null
          or head.claimed_at is not null
          or head.lease_expires_at is not null
          or head.completed_at is not null
     )
     or exists (select 1 from app.sp_write_outbox_delivery_events) then
    raise exception 'SP write outbox delivery backfill does not close'
      using errcode = 'P0003';
  end if;
end;
$$;

select app.sp_write_assert_outbox_delivery_backfill();
drop function app.sp_write_assert_outbox_delivery_backfill();

create or replace function app.sp_write_outbox_domain_complete(p_outbox_id uuid)
returns boolean
language plpgsql
stable
strict
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outbox public.sp_write_outbox%rowtype;
  v_intent public.sp_write_provider_call_intents%rowtype;
  v_result public.sp_write_provider_results%rowtype;
  v_intent_position_count bigint;
  v_result_position_count bigint;
begin
  select * into v_outbox
  from public.sp_write_outbox outbox
  where outbox.outbox_id = p_outbox_id;
  if not found then
    return false;
  end if;

  if v_outbox.kind = 'dispatch' then
    return not exists (
      select 1
      from public.sp_write_plan_actions action
      where action.org_id = v_outbox.org_id
        and action.profile_id = v_outbox.profile_id
        and action.plan_id = v_outbox.plan_id
        and not exists (
          select 1
          from public.sp_write_action_resolutions resolution
          where resolution.org_id = v_outbox.org_id
            and resolution.profile_id = v_outbox.profile_id
            and resolution.execution_id = v_outbox.execution_id
            and resolution.plan_id = v_outbox.plan_id
            and resolution.action_id = action.action_id
        )
    );
  end if;

  select * into v_intent
  from public.sp_write_provider_call_intents intent
  where intent.org_id = v_outbox.org_id
    and intent.profile_id = v_outbox.profile_id
    and intent.execution_id = v_outbox.execution_id
    and intent.plan_id = v_outbox.plan_id
    and intent.approval_id = v_outbox.approval_id
    and intent.generation = v_outbox.generation
    and intent.intent_id = v_outbox.intent_id
    and intent.provider_call_id = v_outbox.provider_call_id;
  if not found then
    return false;
  end if;

  select * into v_result
  from public.sp_write_provider_results result
  where result.org_id = v_outbox.org_id
    and result.profile_id = v_outbox.profile_id
    and result.intent_id = v_intent.intent_id;
  if not found then
    return false;
  end if;

  select count(*) into v_intent_position_count
  from public.sp_write_provider_call_positions position
  where position.org_id = v_outbox.org_id
    and position.profile_id = v_outbox.profile_id
    and position.intent_id = v_intent.intent_id;

  select count(*) into v_result_position_count
  from public.sp_write_provider_result_positions position
  where position.org_id = v_outbox.org_id
    and position.profile_id = v_outbox.profile_id
    and position.intent_id = v_intent.intent_id
    and position.result_id = v_result.result_id;

  return
    v_intent_position_count > 0
    and v_result_position_count = v_intent_position_count
    and not exists (
      select 1
      from public.sp_write_provider_result_positions position
      where position.org_id = v_outbox.org_id
        and position.profile_id = v_outbox.profile_id
        and position.intent_id = v_intent.intent_id
        and position.result_id = v_result.result_id
        and position.outcome <> 'authoritative_rejected'
        and not exists (
          select 1
          from public.sp_write_observations observation
          where observation.org_id = v_outbox.org_id
            and observation.profile_id = v_outbox.profile_id
            and observation.intent_id = v_intent.intent_id
            and observation.result_id = v_result.result_id
            and observation.action_id = position.action_id
            and observation.source_sync_job_id = v_outbox.source_sync_job_id
        )
    );
end;
$$;

create or replace function app.sp_write_outbox_domain_claimable(
  p_outbox_id uuid,
  p_database_now timestamptz
)
returns boolean
language plpgsql
stable
strict
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outbox public.sp_write_outbox%rowtype;
begin
  select * into v_outbox
  from public.sp_write_outbox outbox
  where outbox.outbox_id = p_outbox_id;
  if not found then
    return false;
  end if;
  if app.sp_write_outbox_domain_complete(p_outbox_id) then
    return true;
  end if;
  if v_outbox.kind = 'dispatch' then
    return true;
  end if;
  if exists (
    select 1
    from public.sp_write_provider_results result
    where result.org_id = v_outbox.org_id
      and result.profile_id = v_outbox.profile_id
      and result.intent_id = v_outbox.intent_id
  ) then
    return true;
  end if;
  return exists (
    select 1
    from public.sp_write_provider_call_intents intent
    join public.sp_write_dispatch_leases lease
      on lease.org_id = intent.org_id
     and lease.profile_id = intent.profile_id
     and lease.execution_id = intent.execution_id
     and lease.plan_id = intent.plan_id
     and lease.approval_id = intent.approval_id
     and lease.generation = intent.generation
     and lease.route_key = intent.route_key
     and lease.lease_id = intent.dispatch_lease_id
    where intent.org_id = v_outbox.org_id
      and intent.profile_id = v_outbox.profile_id
      and intent.intent_id = v_outbox.intent_id
      and intent.provider_call_id = v_outbox.provider_call_id
      and p_database_now >= intent.provider_attempt_deadline
      and p_database_now >= lease.expires_at
  );
end;
$$;

-- -------------------------------------------------------------------------
-- Controlled custody transitions
-- -------------------------------------------------------------------------

create or replace function app.claim_sp_write_outbox(
  p_claimant_id text,
  p_kinds public.sp_write_outbox_kind[],
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  offered_count integer,
  claimed_count integer,
  claim_ordinal integer,
  outbox_id uuid,
  org_id uuid,
  profile_id uuid,
  execution_id uuid,
  plan_id uuid,
  approval_id uuid,
  generation uuid,
  kind public.sp_write_outbox_kind,
  provider_call_id uuid,
  intent_id uuid,
  source_sync_job_id uuid,
  claim_epoch bigint,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_scan_now timestamptz;
  v_now timestamptz;
  v_candidate record;
  v_candidate_ids uuid[] := array[]::uuid[];
  v_candidate_id uuid;
  v_ordinal integer := 0;
  v_offered integer;
  v_claimed integer := 0;
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_outbox public.sp_write_outbox%rowtype;
  v_token uuid;
  v_digest text;
  v_event_kind text;
  v_affected integer;
begin
  perform app.assert_service_role('claim_sp_write_outbox');
  if p_claimant_id is null
     or p_claimant_id <> btrim(p_claimant_id)
     or p_claimant_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'SP write outbox claimant is invalid' using errcode = '22023';
  end if;
  if p_kinds is null
     or cardinality(p_kinds) = 0
     or exists (select 1 from unnest(p_kinds) requested(kind_value) where kind_value is null)
     or (select count(distinct kind_value) from unnest(p_kinds) requested(kind_value))
        <> cardinality(p_kinds) then
    raise exception 'SP write outbox kind allowlist is invalid' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'SP write outbox claim limit must be between 1 and 10'
      using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 70 or p_lease_seconds > 300 then
    raise exception 'SP write outbox lease must be between 70 and 300 seconds'
      using errcode = '22023';
  end if;

  -- The scan clock is only a conservative prefilter. Authority uses v_now,
  -- captured after every selected head has been locked.
  v_scan_now := clock_timestamp();
  for v_candidate in
    with current_custody as materialized (
      select head.outbox_id
      from app.sp_write_outbox_delivery_heads head
      join public.sp_write_outbox source
        on source.org_id = head.org_id
       and source.profile_id = head.profile_id
       and source.outbox_id = head.outbox_id
      where source.kind = any(p_kinds)
        and head.state <> 'completed'
        and (
          (head.state = 'available' and v_scan_now >= head.available_at)
          or (head.state = 'leased' and v_scan_now >= head.lease_expires_at)
        )
    )
    select head.outbox_id as candidate_outbox_id
    from current_custody custody
    join app.sp_write_outbox_delivery_heads head
      on head.outbox_id = custody.outbox_id
    join public.sp_write_outbox source
      on source.org_id = head.org_id
     and source.profile_id = head.profile_id
     and source.outbox_id = head.outbox_id
    where case
      when head.state <> 'completed' and (
        (head.state = 'available' and v_scan_now >= head.available_at)
        or (head.state = 'leased' and v_scan_now >= head.lease_expires_at)
      ) then app.sp_write_outbox_domain_claimable(source.outbox_id, v_scan_now)
      else false
    end
    order by source.created_at, source.outbox_id
    limit p_limit
    for update of head skip locked
  loop
    v_candidate_ids := array_append(v_candidate_ids, v_candidate.candidate_outbox_id);
  end loop;

  v_offered := cardinality(v_candidate_ids);
  v_now := clock_timestamp();
  if v_offered = 0 then
    offered_count := 0;
    claimed_count := 0;
    claim_ordinal := null;
    outbox_id := null;
    org_id := null;
    profile_id := null;
    execution_id := null;
    plan_id := null;
    approval_id := null;
    generation := null;
    kind := null;
    provider_call_id := null;
    intent_id := null;
    source_sync_job_id := null;
    claim_epoch := null;
    claimed_at := null;
    lease_expires_at := null;
    claim_token := null;
    return next;
    return;
  end if;

  foreach v_candidate_id in array v_candidate_ids loop
    select * into strict v_head
    from app.sp_write_outbox_delivery_heads head
    where head.outbox_id = v_candidate_id;
    select * into strict v_outbox
    from public.sp_write_outbox source
    where source.org_id = v_head.org_id
      and source.profile_id = v_head.profile_id
      and source.outbox_id = v_head.outbox_id;
    if not (
         v_head.state <> 'completed'
         and (
           (v_head.state = 'available' and v_now >= v_head.available_at)
           or (v_head.state = 'leased' and v_now >= v_head.lease_expires_at)
         )
         and v_outbox.kind = any(p_kinds)
         and app.sp_write_outbox_domain_claimable(v_outbox.outbox_id, v_now)
       ) then
      raise exception 'SP write outbox locked candidate failed exact recheck'
        using errcode = 'P0003';
    end if;

    v_token := gen_random_uuid();
    v_digest := app.sp_write_outbox_claim_token_digest(v_token);
    v_event_kind := case when v_head.state = 'leased'
      then 'expired_reclaimed' else 'claimed' end;

    update app.sp_write_outbox_delivery_heads head
    set state = 'leased',
        claim_epoch = v_head.claim_epoch + 1,
        transition_sequence = v_head.transition_sequence + 1,
        claimant_id = p_claimant_id,
        token_digest = v_digest,
        claimed_at = v_now,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
        available_at = null,
        attempt_count = v_head.attempt_count + 1,
        completed_at = null
    where head.outbox_id = v_head.outbox_id;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox claim head count does not close'
        using errcode = 'P0003';
    end if;

    insert into app.sp_write_outbox_delivery_events (
      org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
      event_kind, actor_claimant_id, actor_token_digest, recorded_at,
      claimed_at, lease_expires_at, available_at, completed_at, defer_reason
    ) values (
      v_head.org_id, v_head.profile_id, v_head.outbox_id,
      v_head.transition_sequence + 1, v_head.claim_epoch + 1,
      v_event_kind, p_claimant_id, v_digest, v_now,
      v_now, v_now + make_interval(secs => p_lease_seconds),
      null, null, null
    );
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox claim event count does not close'
        using errcode = 'P0003';
    end if;

    v_claimed := v_claimed + 1;
    v_ordinal := v_ordinal + 1;
    offered_count := v_offered;
    claimed_count := v_offered;
    claim_ordinal := v_ordinal;
    outbox_id := v_outbox.outbox_id;
    org_id := v_outbox.org_id;
    profile_id := v_outbox.profile_id;
    execution_id := v_outbox.execution_id;
    plan_id := v_outbox.plan_id;
    approval_id := v_outbox.approval_id;
    generation := v_outbox.generation;
    kind := v_outbox.kind;
    provider_call_id := v_outbox.provider_call_id;
    intent_id := v_outbox.intent_id;
    source_sync_job_id := v_outbox.source_sync_job_id;
    claim_epoch := v_head.claim_epoch + 1;
    claimed_at := v_now;
    lease_expires_at := v_now + make_interval(secs => p_lease_seconds);
    claim_token := v_token;
    return next;
  end loop;

  if v_claimed <> v_offered
     or (select count(*)
         from app.sp_write_outbox_delivery_heads head
         where head.outbox_id = any(v_candidate_ids)
           and head.state = 'leased'
           and head.claimant_id = p_claimant_id
           and head.claimed_at = v_now) <> v_offered
     or (select count(*)
         from app.sp_write_outbox_delivery_events event
         where event.outbox_id = any(v_candidate_ids)
           and event.recorded_at = v_now
           and event.actor_claimant_id = p_claimant_id
           and event.event_kind in ('claimed', 'expired_reclaimed')) <> v_offered then
    raise exception 'SP write outbox claim batch count does not close'
      using errcode = 'P0003';
  end if;
end;
$$;

create or replace function app.renew_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_lease_seconds integer
)
returns table (decision text, checked_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_now timestamptz;
  v_new_expiry timestamptz;
  v_digest text;
  v_affected integer;
begin
  perform app.assert_service_role('renew_sp_write_outbox_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null or p_lease_seconds is null
     or p_lease_seconds < 70 or p_lease_seconds > 300 then
    raise exception 'SP write outbox renewal input is invalid' using errcode = '22023';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.outbox_id = p_outbox_id
  for update;
  v_now := clock_timestamp();
  checked_at := v_now;
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);
  if not found
     or v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    decision := 'stale_claim';
    expires_at := null;
    return next;
    return;
  end if;

  v_new_expiry := least(
    v_now + make_interval(secs => p_lease_seconds),
    v_head.claimed_at + interval '300 seconds'
  );
  if v_new_expiry <= v_head.lease_expires_at then
    decision := 'renewal_limit_reached';
    expires_at := v_head.lease_expires_at;
    return next;
    return;
  end if;

  update app.sp_write_outbox_delivery_heads head
  set transition_sequence = v_head.transition_sequence + 1,
      lease_expires_at = v_new_expiry
  where head.outbox_id = p_outbox_id;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'SP write outbox renewal head count does not close'
      using errcode = 'P0003';
  end if;
  insert into app.sp_write_outbox_delivery_events (
    org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
    event_kind, actor_claimant_id, actor_token_digest, recorded_at,
    claimed_at, lease_expires_at, available_at, completed_at, defer_reason
  ) values (
    v_head.org_id, v_head.profile_id, v_head.outbox_id,
    v_head.transition_sequence + 1, v_head.claim_epoch,
    'renewed', v_head.claimant_id, v_digest, v_now,
    v_head.claimed_at, v_new_expiry, null, null, null
  );
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'SP write outbox renewal event count does not close'
      using errcode = 'P0003';
  end if;
  decision := 'renewed';
  expires_at := v_new_expiry;
  return next;
end;
$$;

create or replace function app.defer_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_reason text
)
returns table (
  decision text,
  reason text,
  checked_at timestamptz,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_latest app.sp_write_outbox_delivery_events%rowtype;
  v_now timestamptz;
  v_available_at timestamptz;
  v_digest text;
  v_backoff_seconds integer;
  v_affected integer;
begin
  perform app.assert_service_role('defer_sp_write_outbox_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null
     or p_reason is null
     or p_reason not in (
       'reservation_busy', 'observation_pending', 'recovery_pending', 'shutdown'
     ) then
    raise exception 'SP write outbox defer input is invalid' using errcode = '22023';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.outbox_id = p_outbox_id
  for update;
  v_now := clock_timestamp();
  checked_at := v_now;
  reason := null;
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);

  if found
     and v_head.state = 'leased'
     and v_head.claim_epoch = p_claim_epoch
     and v_head.token_digest = v_digest
     and v_head.lease_expires_at > v_now then
    v_backoff_seconds := least(
      300,
      (15 * power(2::numeric, least(greatest(v_head.attempt_count - 1, 0), 5)))::integer
    );
    v_available_at := v_now + make_interval(secs => v_backoff_seconds);
    update app.sp_write_outbox_delivery_heads head
    set state = 'available',
        transition_sequence = v_head.transition_sequence + 1,
        claimant_id = null,
        token_digest = null,
        claimed_at = null,
        lease_expires_at = null,
        available_at = v_available_at,
        completed_at = null
    where head.outbox_id = p_outbox_id;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox defer head count does not close'
        using errcode = 'P0003';
    end if;
    insert into app.sp_write_outbox_delivery_events (
      org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
      event_kind, actor_claimant_id, actor_token_digest, recorded_at,
      claimed_at, lease_expires_at, available_at, completed_at, defer_reason
    ) values (
      v_head.org_id, v_head.profile_id, v_head.outbox_id,
      v_head.transition_sequence + 1, v_head.claim_epoch,
      'deferred', v_head.claimant_id, v_digest, v_now,
      null, null, v_available_at, null, p_reason
    );
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox defer event count does not close'
        using errcode = 'P0003';
    end if;
    decision := 'deferred';
    reason := p_reason;
    available_at := v_available_at;
    return next;
    return;
  end if;

  if found then
    select * into v_latest
    from app.sp_write_outbox_delivery_events event
    where event.outbox_id = v_head.outbox_id
      and event.transition_sequence = v_head.transition_sequence;
    if found
       and v_latest.event_kind = 'deferred'
       and v_latest.claim_epoch = p_claim_epoch
       and v_latest.actor_token_digest = v_digest
       and v_latest.defer_reason = p_reason then
      decision := 'already_deferred';
      reason := p_reason;
      available_at := v_latest.available_at;
      return next;
      return;
    end if;
  end if;
  decision := 'stale_claim';
  available_at := null;
  return next;
end;
$$;

create or replace function app.complete_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid
)
returns table (decision text, checked_at timestamptz, completed_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outbox public.sp_write_outbox%rowtype;
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_latest app.sp_write_outbox_delivery_events%rowtype;
  v_now timestamptz;
  v_digest text;
  v_affected integer;
begin
  perform app.assert_service_role('complete_sp_write_outbox_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null then
    raise exception 'SP write outbox completion input is invalid' using errcode = '22023';
  end if;
  select * into v_outbox
  from public.sp_write_outbox source
  where source.outbox_id = p_outbox_id;
  if not found then
    raise exception 'SP write outbox completion dependency is missing' using errcode = 'P0002';
  end if;
  perform 1 from public.orgs org where org.id = v_outbox.org_id for key share;
  if not found then
    raise exception 'SP write outbox completion tenant is missing' using errcode = 'P0002';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.org_id = v_outbox.org_id
    and head.profile_id = v_outbox.profile_id
    and head.outbox_id = v_outbox.outbox_id
  for update;
  if not found then
    raise exception 'SP write outbox completion head is missing' using errcode = 'P0002';
  end if;
  v_now := clock_timestamp();
  checked_at := v_now;
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);

  if v_head.state = 'completed' then
    select * into v_latest
    from app.sp_write_outbox_delivery_events event
    where event.outbox_id = v_head.outbox_id
      and event.transition_sequence = v_head.transition_sequence;
    if found
       and v_latest.event_kind = 'completed'
       and v_latest.claim_epoch = p_claim_epoch
       and v_latest.actor_token_digest = v_digest then
      decision := 'already_completed';
      completed_at := v_latest.completed_at;
    else
      decision := 'stale_claim';
      completed_at := null;
    end if;
    return next;
    return;
  end if;
  if v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    decision := 'stale_claim';
    completed_at := null;
    return next;
    return;
  end if;
  if not app.sp_write_outbox_domain_complete(v_outbox.outbox_id) then
    decision := 'not_complete';
    completed_at := null;
    return next;
    return;
  end if;

  update app.sp_write_outbox_delivery_heads head
  set state = 'completed',
      transition_sequence = v_head.transition_sequence + 1,
      claimant_id = null,
      token_digest = null,
      claimed_at = null,
      lease_expires_at = null,
      available_at = null,
      completed_at = v_now
  where head.outbox_id = v_head.outbox_id;
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'SP write outbox completion head count does not close'
      using errcode = 'P0003';
  end if;
  insert into app.sp_write_outbox_delivery_events (
    org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
    event_kind, actor_claimant_id, actor_token_digest, recorded_at,
    claimed_at, lease_expires_at, available_at, completed_at, defer_reason
  ) values (
    v_head.org_id, v_head.profile_id, v_head.outbox_id,
    v_head.transition_sequence + 1, v_head.claim_epoch,
    'completed', v_head.claimant_id, v_digest, v_now,
    null, null, null, v_now, null
  );
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'SP write outbox completion event count does not close'
      using errcode = 'P0003';
  end if;
  decision := 'completed';
  completed_at := v_now;
  return next;
end;
$$;

-- -------------------------------------------------------------------------
-- Claim-bound access to the canonical WP-187 mutation-authority boundary
-- -------------------------------------------------------------------------

create or replace function app.acquire_sp_write_dispatch_lease_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_route_key public.sp_write_route_key,
  p_lease_seconds integer
)
returns table (lease_id uuid, acquired_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outbox public.sp_write_outbox%rowtype;
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_lease record;
  v_now timestamptz;
  v_digest text;
begin
  perform app.assert_service_role('acquire_sp_write_dispatch_lease_for_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null or p_route_key is null
     or p_lease_seconds is null or p_lease_seconds < 70 or p_lease_seconds > 300 then
    raise exception 'SP write claim-bound dispatch lease input is invalid'
      using errcode = '22023';
  end if;

  -- Immutable identity is not authority. The organisation is the first lock.
  select * into v_outbox
  from public.sp_write_outbox source
  where source.outbox_id = p_outbox_id;
  if not found then
    raise exception 'SP write claim-bound dispatch dependency is missing'
      using errcode = 'P0002';
  end if;
  perform 1 from public.orgs org where org.id = v_outbox.org_id for key share;
  if not found then
    raise exception 'SP write claim-bound dispatch tenant is missing'
      using errcode = 'P0002';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.org_id = v_outbox.org_id
    and head.profile_id = v_outbox.profile_id
    and head.outbox_id = v_outbox.outbox_id
  for update;
  if not found then
    raise exception 'SP write claim-bound dispatch head is missing'
      using errcode = 'P0002';
  end if;
  v_now := clock_timestamp();
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);
  if v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    raise exception 'SP write dispatch claim is unavailable' using errcode = '55P03';
  end if;
  if v_outbox.kind <> 'dispatch'
     or v_outbox.provider_call_id is not null
     or v_outbox.intent_id is not null
     or v_outbox.source_sync_job_id is not null then
    raise exception 'SP write dispatch claim does not identify a dispatch wake'
      using errcode = '22023';
  end if;

  select canonical.lease_id, canonical.acquired_at, canonical.expires_at
  into strict v_lease
  from app.acquire_sp_write_dispatch_lease(
    v_outbox.execution_id,
    v_outbox.plan_id,
    v_outbox.generation,
    p_route_key,
    p_lease_seconds
  ) canonical;

  v_now := clock_timestamp();
  select * into strict v_head
  from app.sp_write_outbox_delivery_heads head
  where head.org_id = v_outbox.org_id
    and head.profile_id = v_outbox.profile_id
    and head.outbox_id = v_outbox.outbox_id;
  if v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    raise exception 'SP write dispatch claim expired during lease acquisition'
      using errcode = '40001';
  end if;
  lease_id := v_lease.lease_id;
  acquired_at := v_lease.acquired_at;
  expires_at := v_lease.expires_at;
  return next;
end;
$$;

create or replace function app.reserve_sp_write_provider_call_for_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_dispatch_lease_id uuid,
  p_observation_text text,
  p_observation_fingerprint_preimage text,
  p_intent_text text,
  p_request_fingerprint_preimage text,
  p_intent_fingerprint_preimage text
)
returns table (
  decision text,
  refusal_reason text,
  checked_at timestamptz,
  result_id uuid,
  intent_text text
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_outbox public.sp_write_outbox%rowtype;
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_reservation record;
  v_now timestamptz;
  v_digest text;
begin
  perform app.assert_service_role('reserve_sp_write_provider_call_for_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null or p_execution_id is null or p_plan_id is null
     or p_generation is null or p_dispatch_lease_id is null
     or p_observation_text is null or p_observation_fingerprint_preimage is null
     or p_intent_text is null or p_request_fingerprint_preimage is null
     or p_intent_fingerprint_preimage is null then
    raise exception 'SP write claim-bound reservation input is invalid'
      using errcode = '22023';
  end if;

  select * into v_outbox
  from public.sp_write_outbox source
  where source.outbox_id = p_outbox_id;
  if not found then
    raise exception 'SP write claim-bound reservation dependency is missing'
      using errcode = 'P0002';
  end if;
  perform 1 from public.orgs org where org.id = v_outbox.org_id for key share;
  if not found then
    raise exception 'SP write claim-bound reservation tenant is missing'
      using errcode = 'P0002';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.org_id = v_outbox.org_id
    and head.profile_id = v_outbox.profile_id
    and head.outbox_id = v_outbox.outbox_id
  for update;
  if not found then
    raise exception 'SP write claim-bound reservation head is missing'
      using errcode = 'P0002';
  end if;
  v_now := clock_timestamp();
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);
  if v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    decision := 'claim_unavailable';
    refusal_reason := null;
    checked_at := v_now;
    result_id := null;
    intent_text := null;
    return next;
    return;
  end if;
  if v_outbox.kind <> 'dispatch'
     or v_outbox.execution_id <> p_execution_id
     or v_outbox.plan_id <> p_plan_id
     or v_outbox.generation <> p_generation
     or v_outbox.provider_call_id is not null
     or v_outbox.intent_id is not null
     or v_outbox.source_sync_job_id is not null then
    raise exception 'SP write reservation claim does not match the dispatch wake'
      using errcode = '22023';
  end if;

  select canonical.decision, canonical.refusal_reason, canonical.checked_at,
         canonical.result_id, canonical.intent_text
  into strict v_reservation
  from app.reserve_sp_write_provider_call(
    p_execution_id,
    p_plan_id,
    p_generation,
    p_dispatch_lease_id,
    p_observation_text,
    p_observation_fingerprint_preimage,
    p_intent_text,
    p_request_fingerprint_preimage,
    p_intent_fingerprint_preimage
  ) canonical;

  v_now := clock_timestamp();
  select * into strict v_head
  from app.sp_write_outbox_delivery_heads head
  where head.org_id = v_outbox.org_id
    and head.profile_id = v_outbox.profile_id
    and head.outbox_id = v_outbox.outbox_id;
  if v_head.state <> 'leased'
     or v_head.claim_epoch <> p_claim_epoch
     or v_head.token_digest <> v_digest
     or v_head.lease_expires_at <= v_now then
    raise exception 'SP write dispatch claim expired during reservation'
      using errcode = '40001';
  end if;
  decision := v_reservation.decision;
  refusal_reason := v_reservation.refusal_reason;
  checked_at := v_reservation.checked_at;
  result_id := v_reservation.result_id;
  intent_text := v_reservation.intent_text;
  return next;
end;
$$;

-- -------------------------------------------------------------------------
-- Operational immutability and application-role authority
-- -------------------------------------------------------------------------

create or replace function app.reject_sp_write_delivery_head_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if exists (select 1 from public.orgs org where org.id = old.org_id) then
    raise exception 'SP write outbox delivery heads may only cascade with tenant purge'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

create trigger sp_write_outbox_delivery_heads_delete_guard
  before delete on app.sp_write_outbox_delivery_heads
  for each row execute function app.reject_sp_write_delivery_head_delete();
create trigger sp_write_outbox_delivery_heads_no_truncate
  before truncate on app.sp_write_outbox_delivery_heads
  for each statement execute function app.reject_sp_write_evidence_truncate();

create trigger sp_write_outbox_delivery_events_immutable
  before update or delete on app.sp_write_outbox_delivery_events
  for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_outbox_delivery_events_no_truncate
  before truncate on app.sp_write_outbox_delivery_events
  for each statement execute function app.reject_sp_write_evidence_truncate();

revoke all on app.sp_write_outbox_delivery_heads,
  app.sp_write_outbox_delivery_events
from public, anon, authenticated, service_role;

revoke all on function app.claim_sp_write_outbox(
  text, public.sp_write_outbox_kind[], integer, integer
) from public, anon, authenticated, service_role;
revoke all on function app.renew_sp_write_outbox_claim(uuid, bigint, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function app.defer_sp_write_outbox_claim(uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function app.complete_sp_write_outbox_claim(uuid, bigint, uuid)
  from public, anon, authenticated, service_role;
revoke all on function app.acquire_sp_write_dispatch_lease_for_claim(
  uuid, bigint, uuid, public.sp_write_route_key, integer
) from public, anon, authenticated, service_role;
revoke all on function app.reserve_sp_write_provider_call_for_claim(
  uuid, bigint, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function app.claim_sp_write_outbox(
  text, public.sp_write_outbox_kind[], integer, integer
) to service_role;
grant execute on function app.renew_sp_write_outbox_claim(uuid, bigint, uuid, integer)
  to service_role;
grant execute on function app.defer_sp_write_outbox_claim(uuid, bigint, uuid, text)
  to service_role;
grant execute on function app.complete_sp_write_outbox_claim(uuid, bigint, uuid)
  to service_role;
grant execute on function app.acquire_sp_write_dispatch_lease_for_claim(
  uuid, bigint, uuid, public.sp_write_route_key, integer
) to service_role;
grant execute on function app.reserve_sp_write_provider_call_for_claim(
  uuid, bigint, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

-- The old functions remain owner-internal canonical implementations. An
-- application service can reach them only through the claim-bound wrappers.
revoke all on function app.acquire_sp_write_dispatch_lease(
  uuid, uuid, uuid, public.sp_write_route_key, integer
) from public, anon, authenticated, service_role;
revoke all on function app.reserve_sp_write_provider_call(
  uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated, service_role;

revoke all on function
  app.sp_write_outbox_claim_token_digest(uuid),
  app.sp_write_create_outbox_delivery_head(),
  app.sp_write_outbox_domain_complete(uuid),
  app.sp_write_outbox_domain_claimable(uuid, timestamptz),
  app.reject_sp_write_delivery_head_delete()
from public, anon, authenticated, service_role;

create or replace function app.sp_write_assert_outbox_delivery_installation()
returns void
language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if (select count(*) from public.sp_write_outbox)
       <> (select count(*) from app.sp_write_outbox_delivery_heads)
     or exists (
       select 1
       from public.sp_write_outbox outbox
       left join app.sp_write_outbox_delivery_heads head
         on head.org_id = outbox.org_id
        and head.profile_id = outbox.profile_id
        and head.outbox_id = outbox.outbox_id
       where head.outbox_id is null
     )
     or has_table_privilege('anon', 'app.sp_write_outbox_delivery_heads', 'SELECT')
     or has_table_privilege('authenticated', 'app.sp_write_outbox_delivery_heads', 'SELECT')
     or has_table_privilege('service_role', 'app.sp_write_outbox_delivery_heads', 'SELECT')
     or has_table_privilege('service_role', 'app.sp_write_outbox_delivery_events', 'INSERT')
     or has_function_privilege(
       'service_role',
       'app.acquire_sp_write_dispatch_lease(uuid,uuid,uuid,public.sp_write_route_key,integer)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'app.reserve_sp_write_provider_call(uuid,uuid,uuid,uuid,text,text,text,text,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'app.claim_sp_write_outbox(text,public.sp_write_outbox_kind[],integer,integer)',
       'EXECUTE'
     ) then
    raise exception 'SP write outbox delivery installation does not close'
      using errcode = 'P0003';
  end if;
end;
$$;

revoke all on function app.sp_write_assert_outbox_delivery_installation()
  from public, anon, authenticated, service_role;
select app.sp_write_assert_outbox_delivery_installation();
drop function app.sp_write_assert_outbox_delivery_installation();
