# Hosted-migration root authority

WP-199 is a source-only Linux Rust library and offline test harness for the private root journal,
fixed root IPC codecs and one-use approval/ticket state transitions.

It is intentionally unusable outside its tests: the crate publishes no callable API, binary,
listener, signer, policy, clock, entropy source, state-directory constructor or deployment artifact.
It cannot launch a process or reach a network, database, Supabase project or credential.

The empty, non-default `wp201-internal` feature reserves the WP-201 bridge boundary. It currently
exposes no bridge or callable API, and only the private `hosted-migration-preparation-proof` tool may
depend on this crate and enable it.

The existing authority contract remains `docs/design/WP-199-ARCHITECTURE.md`; the reserved bridge
boundary is specified by `docs/design/WP-201-ARCHITECTURE.md`.
