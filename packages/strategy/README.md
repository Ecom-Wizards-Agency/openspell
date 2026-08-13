# @wizard-ads/strategy

Tenant config resolution: neutral defaults, then the goal lens, then the tenant document, then
the profile override, with a provenance record saying which layer supplied each value.

**No doctrine values live in this repository.** This package ships structure and merge order.
The numbers are per-tenant database data (`profile_strategy` jsonb), seeded by an operator-run
script from a gitignored local file. `_local/strategy.TEMPLATE.json` shows the document's shape
with every value replaced by a placeholder, and a test fails if a number ever appears in it.

## The WP-00.1 widening — what reads each new field

WP-00.1 widened `TenantStrategy` (in `packages/shared/src/strategy.ts`) so the operator's live
strategy document has a home for every leaf it carries. Widening only: every added key is
optional and no existing key changed meaning, so documents seeded against the earlier shape keep
parsing and no consumer had to change.

Nothing below is wired yet. This is the map the consuming work packages implement against; the
resolver exposes the values, and each engine decides what to do with them.

| Field | Consumer | What it means there |
|---|---|---|
| `opt_groups.<g>.bid_ceiling_unit` / `bid_ceiling_value` | bidding engine (`packages/core`) | The **manual ceiling**. Clamp the proposed bid to it *before* the change caps apply. The unit says how to read the value: an absolute bid, a share of Amazon's recommended bid, or a multiple of the group's CPC. |
| `opt_groups.<g>.bid_floor_unit` / `bid_floor_value` | bidding engine | The manual floor, read the same way. A bid never proposes below it. |
| `opt_groups.<g>.placement_max_decrease` | placement optimizer | The **placement decrease cap**, the missing counterpart to `caps.max_placement_increase`. Per group, falling back to nothing: absent means the optimizer proposes no placement decrease rather than an unbounded one. |
| `opt_groups.<g>.placement_max_increase` | placement optimizer | Per-group override of `caps.max_placement_increase`. |
| `opt_groups.<g>.max_increase_steady` | bidding engine | The increase ceiling once a group is out of its launch phase, where that differs from `max_increase`. |
| `opt_groups.<g>.spend_share_max` | pacing / budget allocation | Ceiling on the share of profile spend the group may take. |
| `opt_groups.<g>.preset` | staged-apply engine (WP-12) | Named starting point for the group's settings. Opaque string; the engine resolves it. |
| `opt_groups.<g>.tacos_x_breakeven[_min\|_max]` | doctrine engine / recommendations | Target TACOS as a multiple of breakeven, with a band where a range is used instead of a point target. |
| `pacing.warn_above` / `act_above` / `underpace_below` | pacing governor (WP-03 job, WP-07 surface) | Three bands, not one tolerance: report, act on the cut order, and flag underspend. `run_rate_tolerance` stays as a deprecated single-tolerance fallback. |
| `pacing.rank_cut_requires_operator` | pacing governor | Guard on the last step of `cut_order`. When true, the `rank` cut is proposed and never applied without an operator decision. |
| `rank_lifecycle.graduate_weeks_stable` | rank lifecycle (WP-08 tags, recommendations) | **Weeks**, because it counts review cycles. `dwell_days` next to it is **days**. Both units are stated on the key and in the contract's doc comment; a lifecycle that mixes the two silently is a bug factory. |
| `rank_lifecycle.stepdown_cycles_min` / `_max` | rank lifecycle | How many step-down cycles a graduated keyword walks through. |
| `rank_lifecycle.regression_reescalate` | rank lifecycle | What a regressed keyword returns to. |
| `staged_apply.max_batches_per_run` | staged-apply engine (WP-12) | Batches one run may push before it stops and waits for the next cycle. |
| `staged_apply.cooldown_bypasses` | staged-apply engine | Levers allowed to ignore `cooldown_days`. |
| `staged_apply.tag_format` | staged-apply engine + WP-08 tags | Template for the tag written onto a changed entity, so a batch can be found and reverted. |
| `staged_apply.push_rank_min_days` | staged-apply engine | Minimum days between two pushes on the same rank target. |
| `staged_apply.priority_order` | staged-apply engine | Order the levers are worked through when a run cannot do everything. |
| `staged_apply.group_cadence` | staged-apply engine | How often each opt group is touched, keyed by group name. |
| `staged_apply.batch_unit` | staged-apply engine | What one batch counts (rows, entities). |
| `discovery.min_root_words` | n-gram / discovery (`packages/core`) | Minimum words a root needs to count as a discovery root. |
| `expanded_candidate_filter.min_relevancy` / `max_sv` | keyword candidate intake | Gate an expanded (tool- or agent-suggested) candidate must clear to be considered. |

## Note for the WP-01 seeder

The operator's source document is not this contract, and the seeder is where the difference is
resolved. It must, in this order:

1. **Flatten `management.*`.** The source nests `pacing`, `opt_groups`, `rank_lifecycle` and
   `staged_apply` under a `management` object. This contract keeps them at the top level, next
   to `bids`, `sv_bands`, `caps`, `naming` — one level, one place to look.
2. **Rewrite the schema id** to `wizard-ads.tenant-strategy.v1` (`TENANT_STRATEGY_SCHEMA`).
   `TenantStrategy` pins it with `z.literal`, so a source document keeps its own id and the
   seeder states the target one.
3. **Rename the source's key spellings to the contract's**, so nothing is silently dropped —
   `parse` strips unknown keys, which means an unrenamed field fails quietly, not loudly:

   | Source key | Contract key |
   |---|---|
   | `management.opt_groups.<g>.bid_max_increase_value` | `opt_groups.<g>.max_increase` |
   | `management.opt_groups.<g>.bid_max_increase_steady` | `opt_groups.<g>.max_increase_steady` |
   | `management.opt_groups.<g>.bid_max_decrease_value` | `opt_groups.<g>.max_decrease` |
   | `management.rank_lifecycle.graduate_rank_max` | `rank_lifecycle.graduation_rank` |
   | `management.rank_lifecycle.regression_rank_beyond` | `rank_lifecycle.demotion_rank` |

4. **Normalize the bid-bound unit tokens** to this contract's lower snake_case vocabulary
   (`absolute`, `pct_of_recommended`, `times_cpc`). Enum tokens are lowercase throughout this
   contract; a source that screams them is normalized here rather than given a second spelling
   in the contract.
5. **Verify coverage, not exit code.** Count the source document's leaf paths and assert every
   one landed somewhere in the seeded document. A seed that parses while dropping half the
   doctrine is the failure this step exists to catch.
