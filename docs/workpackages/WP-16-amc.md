# WP-16 — AMC (Amazon Marketing Cloud) lane

**Owner:** Claude Opus · **Phase:** v2 · **GATED on:** first provisioned AMC instance on a
managed account + an AWS bucket for result delivery. Planned 2026-08-14 (operator: sponsored-
ads AMC access is broadly available now — verify per account at gate-open, it changes often).

## Goal

AMC as a first-class module: instance connection, SQL query workbench with a curated query
library, scheduled workflows, and AMC audiences pushed to Sponsored Display targeting.
AdLabs gates this behind Pro; ours ships with the same primitives plus our query library
pre-loaded.

## Shape (design now, build at gate-open)

1. **Provisioning/admin**: connect an advertiser's AMC instance via the Ads API AMC
   administration endpoints (same LWA app, AMC scopes added). Store per-org instance refs in
   a reserved `amc_instances` table (additive migration at build time; no seam reserved today
   — the feature is self-contained).
2. **Result delivery**: AMC delivers query results to S3. One agency-owned bucket +
   per-instance prefixes; the worker gains an `amc.poll`/`amc.fetch` job pair mirroring the
   reporting three-pass pattern. This is the only AWS dependency in the tool — isolate it in
   the worker behind one module.
3. **Query workbench**: SQL editor with the AMC schema reference, run/history, result grid
   (reuses the WP-06 DataGrid), size caps. Curated query library seeded from our own set
   (new-to-brand, overlap, path-to-conversion, frequency — the classics AdLabs publishes as
   their 15-query library; ours can start from the same public patterns).
4. **Audiences**: create AMC audiences from query results; surface them for SD targeting.
   Writes go through the apply-batch audit path like every other write (WP-12 machinery).
5. **MCP**: `amc_query` (read) + audit-logged audience creation (write-gated) tools.

## Explicitly out of scope until gate-open

DSP anything (needs a seat), Marketing Stream (separate lane), building the S3 plumbing
speculatively.

## Acceptance sketch (firm up at gate-open)

Instance connect round-trip on one managed account · a library query executes end-to-end
(submit → S3 → grid) with rows counted at each hop · scheduled weekly workflow lands results
without operator action · audience created from a query appears in SD targeting options ·
every AMC call in audit_log.
