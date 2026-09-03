# Hosted migration bundle construction and review

This runbook covers WP-197's offline construction, independent verification, and review evidence.
It does not authorize or perform a hosted migration, migration-history repair, credential change,
service change, authority transition, deployment, provider call, or Amazon write.

## Boundary

The bundle preserves a byte-authoritative 41-file hosted-history snapshot and appends the five
reviewed Git blobs through WP-196. The history snapshot is input evidence, not repository history.
Do not replace its files with similarly named repository migrations and do not replay it on a new
database.

Construction has no network or database capability. A successful local verification proves only
the artifact's bytes and source provenance. It does not prove that the snapshot is fresh, identify
a hosted project, or grant permission for any later operation.

Construction requires Linux with a mounted, usable `/proc/self/fd`. It claims the output basename
through a held parent-directory descriptor, opens and holds the claimed output inode, and performs
every later marker, payload, private-check and sync operation through that output descriptor. It
rechecks canonical parent and output path bindings against the held descriptors. `build` fails closed
when that custody path is unavailable; the public `verify` operation may remain portable.

Keep all generated material outside the repository. Use fresh, private, disposable work
directories for the history input, sealed output, and any later CLI clone. Never reuse the sealed
bundle itself as a CLI work directory.

## Construct the sealed artifact

Start from a clean checkout where `HEAD`, local `origin/main`, and the fully reviewed 40-character
revision are identical. The history work directory must contain exactly the fetched
`supabase/migrations` directory expected by WP-197. Its CLI-owned `.temp` data and every sibling are
out of scope and must not be copied.

Choose a new output path that does not exist and is outside both the checkout and history input.
Then run:

```bash
pnpm migration:bundle -- build --history-workdir "$history_workdir" --output-workdir "$bundle_workdir" --revision "$revision"
pnpm migration:bundle -- verify --mode sealed --bundle-workdir "$bundle_workdir" --revision "$revision"
```

Do not infer success from an exit code. Capture the bounded JSON from both commands and require exact
agreement on:

- source revision;
- 41 baseline files and five additions;
- 46 total files and 646628 total bytes;
- terminal version `20260901060000`;
- baseline ledger digest
  `9dd52d5fdee63b6b3c19de850ec72c27f3d8312a5bb5c73c492705e47c18bcea`;
- bundle ledger digest
  `baef4df400ed7a045395322667e1d3ac61fa27075b2d36bb855071a6bfe20458`;
- one identical manifest digest.

The published tree must contain only `BUNDLE_MANIFEST.json` and 46 regular files under
`supabase/migrations`. It must not contain `.BUNDLE_UNPUBLISHED`, `.temp`, configuration, target
linkage, credentials, seeds, functions, hooks, SQL outside the fixed migration set, or another
top-level entry.

If construction loses its response, do not delete or rebuild the requested output. Run sealed
verification against that exact output. A marked artifact is unpublished and must be refused; an
unmarked artifact is accepted only if the complete independent verification succeeds.

## Review custody

The reviewer receives the sealed artifact, the two local evidence records, and the exact reviewed
revision. Review the deterministic manifest, all 46 migration entries, the five Git-blob hashes,
canonical ordering, byte totals, ledger digests, and absence of unrelated files. Keep the sealed
artifact read-only and under single-party custody during review.

Any later dry run uses a new private clone. After CLI metadata has been created, verify that clone
in `cli-workdir` mode. That mode permits only `supabase/.temp` beyond the sealed layout, ignores its
contents, and rehashes every migration and the manifest. Discard the clone after its evidence phase;
never promote it back to the sealed artifact.

## Read-only database evidence

The SQL files under `tools/hosted-migration-bundle/sql/` are offline evidence queries, not
migrations or deployment assets:

1. `wp-197-hosted-migration-probe.sql` closes the exact ordered ledger version list, terminal
   version, prefix classification and milestone-object pattern. It reports separate aggregate counts
   for other granted/waiting holders of the shared schema-DDL advisory key and for all, active and
   lock-waiting sessions under the fixed guarded-CLI application-name prefix. It selects exactly one
   prefix script.
2. Run only the selected `wp-197-hosted-migration-prefix-41.sql` through
   `wp-197-hosted-migration-prefix-46.sql` file.
3. Run the universal probe again. Require its complete typed row to canonicalize to the same JSON
   and SHA-256 as the first probe row, and require all five activity counts to remain zero.
4. Require every returned `pass` value to be true, all rows to carry the same
   `prefixEvidenceSha256`, and each of the four named fingerprints to be present and identical on
   every row.

Every script opens a repeatable-read, transaction-read-only transaction, sets bounded timeouts,
uses static SQL only, returns aggregates or digests, and rolls back. It accepts no target, expected
fingerprint, freeze, CLI, or credential argument. A failed, missing, duplicate, non-ASCII, or
unexpected row makes the observation invalid.

The prefix scripts close these forward-only states:

| Prefix | Terminal version | Required evidence |
|---:|---|---|
| 41 | `20260901010000` | All WP-187 through WP-196 objects are absent. |
| 42 | `20260901020000` | WP-187 objects and ACLs exist; all 28 row-bearing SP relations are empty. |
| 43 | `20260901030000` | WP-192 delivery heads close one-for-one in genesis state; events are empty. |
| 44 | `20260901040000` | WP-194 claim tokens are null; report authority is `legacy`, epoch zero. |
| 45 | `20260901050000` | WP-195 preview/scope relations are empty; historical scope fields are null. |
| 46 | `20260901060000` | WP-196 roles, grants, policies, scheduler exclusion, and `legacy/legacy` authority close. |

The named `queueFingerprint`, `recommendationFingerprint`, `scheduleFingerprint`, and
`outOfScopePrivilegeFingerprint` are observations, not embedded expected values. A guarded runner
must compare the current values byte-for-byte with the separately retained preflight leaf and emit
the canonical comparison record specified by the WP-197 architecture. Any mismatch refuses further
authorization.

The standalone probe and unguarded probe/prefix/probe sequence are instantaneous review evidence.
Because the three scripts are separate transactions, they do not close either gap around the prefix
query and are never apply or suffix-authorization evidence. The public SQL reports aggregates only;
it cannot identify or bind a matching migration session. It also cannot prove target identity,
enqueue-freeze custody, CLI identity, local artifact custody, an already-running child process, or
the absence of an actor that ignores the shared advisory key. Those are separate private evidence
and operational-exclusivity conditions, not claims made by a passing query.

## Later authorization gates

The following remain separate, explicitly attended or narrowly guarded gates after WP-197 is
merged and exact-main CI passes:

1. acquire a fresh read-only history snapshot and bind its private target fingerprint;
2. resolve and copy the reviewed CLI `2.116.0` executable into a private operation directory, then
   bind its path identity, bytes, version, and provenance;
3. establish a separately authorized recommendation-enqueue freeze, settle active work under an
   explicit decision, and retain the freeze through reconciliation and postflight;
4. while holding a separate broker target lock, open one target-bound database guard session,
   acquire the exact session-level schema-DDL advisory lock without waiting, and on that same session
   capture a probe/prefix/probe sandwich plus the four named state fingerprints;
5. perform a dry run against an explicit validated project selection and capture its exact offered
   suffix;
6. seal the disposable CLI clone except for CLI-owned `.temp`, then reverify it after dry run and
   immediately before a later write authorization;
7. immediately revalidate the continuously held database guard and repeat the same-session
   probe/prefix/probe sandwich, then issue a short-lived, single-use private authorization envelope
   binding the exact revision, artifact, CLI, target, freeze, dry-run, prefix, comparison, guarded
   database observation,
   operation-private session-tag digest, and phase-stamped observations;
8. after nonce consumption, revalidate the held target lock and database guard, then rerun every
   target, guarded probe/prefix/probe, state-comparison, freeze, executable, and artifact check before
   any child process is created;
9. on the guard session, take a short transaction-held `ACCESS EXCLUSIVE` barrier on the existing
   migration-ledger relation without waiting, then start the exact measured CLI with its operation-
   private application-name tag. Observe and bind exactly one tagged target session blocked solely by
   the guard on that relation with exactly `AccessShareLock`, as established by disposable CLI proof. If the
   handoff is absent, duplicate or ambiguous, terminate the still-blocked child and prove process/
   session termination before ending the barrier. Release only the relation barrier after a valid
   handoff; retain the advisory guard and broker target lock through reconciliation and postflight;
10. reconcile a lost response read-only only after the exact child is conclusively terminal, then
    validate the still-held database guard or reacquire it without waiting under attended ambiguous-
    outcome recovery, require zero sessions with that exact private tag, and rerun the guarded
    probe/prefix/probe sandwich;
11. if a contiguous prefix from 41 through 45 committed, prepare only its remaining forward suffix
    under a new dry run, operation id, nonce, evidence envelope, and authorization;
12. perform postflight database evidence while the enqueue freeze remains held;
13. release the freeze, provision runtime credentials, stage services, activate fenced authority,
    authorize scoped admission, deploy the candidate web revision, run bounded QA, and promote web
    only through their own later authorizations.

No authorization is reusable across those gates. Blind retry, migration repair, reverse SQL,
replay of an applied file, default or linked target selection, and rollback by destructive SQL are
not recovery mechanisms. Provider and Amazon mutations remain locked behind the separate parity and
write-activation program gates.
