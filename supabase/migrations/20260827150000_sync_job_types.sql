-- WP-41: the four integration queue contract members.
--
-- Enum additions stay alone in this migration. Later migrations may use the new
-- labels without relying on an enum value added in the same transaction.

alter type public.sync_job_type add value 'keepa.sync';
alter type public.sync_job_type add value 'rank.sync';
alter type public.sync_job_type add value 'economics.sync';
alter type public.sync_job_type add value 'sqp.categorize';
