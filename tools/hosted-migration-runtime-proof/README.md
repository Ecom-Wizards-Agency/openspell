# Hosted migration runtime proof

Private WP-200 source and disposable proof package. It verifies fixed release provenance and proves
synthetic Linux launcher invariants. It is not authorization, live evidence or a production spawn
gate. It has no public API or binary and does not connect to Supabase or execute the official CLI.

The non-default `wp201-internal` Cargo feature is intentionally empty until the reviewed WP-201
runtime bridge is implemented. It exports no API and reserves one dependency boundary: only the
private `hosted-migration-preparation-proof` coordinator may enable it. Applications, services and
any second consumer remain forbidden.
