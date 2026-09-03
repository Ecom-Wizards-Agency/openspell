# Hosted-migration root authority

WP-199 is a source-only Linux Rust library and offline test harness for the private root journal,
fixed root IPC codecs and one-use approval/ticket state transitions.

It is intentionally unusable outside its tests: the crate publishes no callable API, binary,
listener, signer, policy, clock, entropy source, state-directory constructor or deployment artifact.
It cannot launch a process or reach a network, database, Supabase project or credential.

The normative contract is `docs/design/WP-199-ARCHITECTURE.md`.
