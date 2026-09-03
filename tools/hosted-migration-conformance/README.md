# Hosted migration conformance oracle

This private workspace package verifies the public byte and state contract for the exact standalone
signed leaves specified by WP-197. It checks canonical leaf bytes against separately supplied raw
Ed25519 signatures, derives fixed session tags, folds attestation chains and reduces supplied phase
transcripts. It does not translate or wrap WP-197 evidence.

Runtime-chain checks accept only the pinned official Supabase 2.116.0 front-controller payload and
its optional pinned delegate and require complete one- or two-leaf binding. Phase-transcript checks
additionally keep the launcher signing authority distinct from the root ticket/grant authority; the
standalone chain check has no root-authority input and does not make that claim.

A `conformant` result is not live evidence or authorization. It does not establish freshness, target
identity, operator approval, lock or freeze custody, credential scope, process isolation, successful
application or safety to apply. A production launcher must independently verify its root-owned
records and current external state. This package must never be its sole or final spawn gate.

The package exposes no complete-operation aggregate because that would also require the canonical
operation envelope and all evidence it references. It has no CLI and no filesystem, process,
network, database, credential, signing, key-generation or random-generation capability.
