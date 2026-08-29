-- WP-85 report-ledger enum extension. PostgreSQL requires a newly added enum
-- value to commit before a later migration may use it in a constraint.
alter type public.report_type add value if not exists 'sbAds';
