-- WP-73: make the already-approved feature payloads first-class queue jobs.
--
-- Enum additions stay in their own migration. A later package may add a
-- schedule or handler for one of these labels without a second contract/SQL
-- widening, while the current worker safely dead-letters an unbound handler.

alter type public.sync_job_type add value 'creative.sync';
alter type public.sync_job_type add value 'sqp.request';
alter type public.sync_job_type add value 'history.bootstrap';
alter type public.sync_job_type add value 'report.promote';
alter type public.sync_job_type add value 'marketing_stream.normalize';
