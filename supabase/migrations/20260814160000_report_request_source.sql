-- wizard-ads 0018: where a report row came from.
--
-- Until now every `report_requests` row meant the same thing: we asked Amazon
-- for a report and loaded what came back. The AdLabs history backfill breaks
-- that assumption. It writes fact rows for periods the Amazon Ads API can no
-- longer serve, sourced from an incumbent tool's own store, and those rows are
-- second-hand: Amazon data as somebody else's pipeline kept it.
--
-- The danger is not the data, it is the crosscheck. That job compares our facts
-- against a fresh AdLabs export and reports `verified` when they agree. Feed it
-- facts that came *from* AdLabs and it compares AdLabs against AdLabs, agrees
-- with itself, and returns a confident verdict that means nothing — the worst
-- failure mode a verification tool has, because it is indistinguishable from
-- success.
--
-- So provenance becomes a column rather than a convention. The daily fact
-- tables have no `source` of their own; they have `report_request_id`, so this
-- one column makes "is this row ours or theirs" a join instead of a guess at
-- the shape of `amazon_report_id`. `fact_monthly_rollup` already carries its
-- own `source` and needs nothing here.
--
-- Additive and defaulted: every existing row is `amazon_api`, which is what it
-- always was, and nothing that writes a report request today has to change.

alter table public.report_requests
  add column source text not null default 'amazon_api';

-- A check constraint rather than an enum. New sources are expected (a second
-- incumbent, a manual import), and adding an enum label is a migration plus a
-- Drizzle change plus a zod change; widening a check is one line. The set is
-- still closed, which is the part that matters: an unrecognised source must
-- fail on insert, not silently pass the crosscheck's exclusion.
alter table public.report_requests
  add constraint report_requests_source_known
  check (source in ('amazon_api', 'adlabs_backfill'));

comment on column public.report_requests.source is
  'Where the rows came from. amazon_api = our own Reporting v3 pull. adlabs_backfill = second-hand history imported from AdLabs; the crosscheck must never read facts that point at one of these.';

-- The crosscheck's exclusion and "what did the backfill load for this profile"
-- are the same query shape: one profile, one source, newest window first.
create index report_requests_source_idx
  on public.report_requests (profile_id, source, end_date desc);
