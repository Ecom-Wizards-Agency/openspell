# WP-60 — Stateful optimizer evidence core

## Boundary

This package adds pure optimizer methods only. It performs no I/O, reads no
tenant configuration, calls no Amazon API, and cannot apply a recommendation.
Database persistence, worker orchestration, exports, and operator UI remain
separate work.

## Delivered

- Carries the immutable `OptimizationRunContext` and validates its group,
  profile, role, and observation-group relationships.
- Classifies an exported recommendation as not synchronized, conflicting,
  observation incomplete, evidence insufficient, supported lift, or complete
  no-lift.
- Holds without compounding until the exported value appears in synchronized
  history and a settled matched window passes tenant-supplied evidence gates.
- Compares only explicit one-to-one pre/post match keys, rejects duplicates,
  and reconciles matched counts and volume totals in provenance.
- Continues only on supported lift and emits the exact pre-change value for a
  complete no-lift reversion proposal.
- Applies group caps and additional hard bounds before avoiding mechanically
  rounded values. Bids move by one legal cent; placements move by one legal
  integer point; binding constraints always win and are recorded.
- Supplies no numeric doctrine defaults. Synchronization tolerance, sufficiency
  gates, lift gates, and mechanical intervals are inputs.

## Verification

Synthetic tests cover every evidence state, contract parsing, duplicate-match
rejection, zero-baseline evidence, exact reversion, bid and placement bound
edges, and property matrices. The repository purity gate scans the new runtime
sources for forbidden dependencies and I/O. The output is data-only and exposes
no apply or Amazon-write operation.

## Deferred integration

- A worker must load due groups, synchronized bid history, settled matched
  windows, and tenant policy before calling these functions.
- Observation persistence and export/reversion UI use the existing shared and
  database contracts but are not wired by this pure package.
- Live lift/reversion claims require synchronized account evidence and the
  sustained read-only crosscheck gate.
