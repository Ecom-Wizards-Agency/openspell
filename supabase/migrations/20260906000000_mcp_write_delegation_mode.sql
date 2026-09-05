-- WP-217 enum prerequisite only. This adds no key, authority, receipt or queued work.
-- Commit this file before any later migration uses the new enum label.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter type public.sp_write_approval_mode add value 'delegated_mcp';
