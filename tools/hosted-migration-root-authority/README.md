# Hosted-migration root authority

WP-199 is a source-only Linux Rust library and offline test harness for the private root journal,
fixed root IPC codecs and one-use approval/ticket state transitions.

It is intentionally unusable outside its tests: the crate publishes no callable API, binary,
listener, signer, policy, clock, entropy source, state-directory constructor or deployment artifact.
It cannot launch a process or reach a network, database, Supabase project or credential.

The non-default `wp201-internal` feature exposes only WP-201's descriptor-bound source-proof
installation bridge: exact synthetic installed-policy/bootstrap inspection, one empty-v2-root
installer, and generation-one Fresh recovery. It exposes no v2 operation append, target, process,
network, credential, service, deployment or live-adapter capability. Only the private
`hosted-migration-preparation-proof` tool may depend on this crate and enable it. CI runs the full
v1 suite both without features and with this bridge enabled so the legacy byte and recovery
contract cannot silently diverge.

The existing authority contract remains `docs/design/WP-199-ARCHITECTURE.md`; the installation
bridge and synthetic-only trust boundary are specified by `docs/design/WP-201-ARCHITECTURE.md`.
