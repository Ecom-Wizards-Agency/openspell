# WP-50 — Campaign builder UPDATE mode

## Goal

Port the UPDATE-mode semantics of
`~/os/amazon-agent/tools/amazon-campaign-builder/update_model.py` (653 lines,
read it first, it is the ground truth) into
`packages/campaigns/src/update.ts`, diffing a desired plan against SYNCED
entities from the database instead of parsing a bulk file. Surface it as a
second mode on the campaigns flow ending in a bulksheet export (WP-25
established the bulksheet writer — reuse it).

## Ground rules (port these semantics exactly)

1. **Blank vs End-Date**: a blank field in an update means "leave unchanged";
   an explicit End Date sentinel means "clear it". Never emit a blank that
   Amazon would interpret as a clear.
2. **Portfolio re-send**: when any campaign row is updated, its portfolio
   assignment is re-sent even if unchanged (Amazon drops it otherwise).
3. **Immutable keyword text**: keyword text/match-type cannot be edited —
   an edit becomes archive-old + create-new, and the create must carry the
   current bid unless the plan overrides it.
4. **Cascade dedup**: archiving a campaign implies its ad groups/keywords are
   gone; do not also emit child archive rows (Amazon rejects orphan updates).
5. **Real-ID guard**: update rows must carry real Amazon IDs from the synced
   entities; a plan row that matches nothing synced is an error surfaced in
   preflight, never a silently emitted create.

## Where things live

- Engine: `packages/campaigns/src/` — CREATE mode already ported
  (`plan.ts`, `generate.ts`, `export.ts`, `preflight.ts`, `naming.ts`,
  `keywords.ts`, `constants.ts`). Follow the same style: pure functions,
  no I/O in the engine, engine tests colocated (`engine.test.ts`,
  `parity.test.ts` show the fixture pattern).
- Synced entities: query helpers in `packages/db/src/queries/` (campaigns /
  ad groups / targets). Add a narrow loader if none fits; keep SQL in
  packages/db, not in the engine.
- UI: the campaigns surface in `apps/web` gains an "Update existing" mode —
  desired-state form or JSON paste (match the existing create flow's input
  idiom), preflight panel listing every diff row with its action
  (update/archive/create), then bulksheet download. NO direct Amazon writes —
  export only, per the operator's standing rule (Amazon-touching actions are
  approval-gated; a bulksheet the operator uploads themselves is the approval).

## Parity

`update_model.py` is the reference. Build golden fixtures: construct a synced
state + desired plan in a fixture, run the Python (available at the path
above, `python3`) and the TS engine, compare emitted row sets. Follow
`parity.test.ts` for how CREATE mode did this.

## Verify (merge gate)

- `pnpm typecheck && pnpm lint`
- `WIZARD_ADS_TEST_DATABASE_URL=postgres://postgres:testpg@127.0.0.1:54329/postgres pnpm -r --workspace-concurrency 1 test`
  (DB suites skip silently without the env var — always set it)
- Engine parity fixtures green.
