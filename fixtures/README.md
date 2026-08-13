# fixtures

Owned by **WP-05**. The Python-to-TypeScript parity harness.

- `generate/` Python scripts that import the reference tools in `amazon-agent/tools/`,
  run every selftest scenario on synthetic data, and dump `{input, expected}` goldens.
  The reference code is a **spec, not a dependency**: read it, port it, never import
  it at runtime and never copy files wholesale.
- `golden/` the dumped goldens. Vitest replays them and asserts deep equality.

Synthetic data only. A golden built from a real account is a client data leak with
extra steps, so `fixtures/golden/**/*.local.*` is gitignored for the cases where a
local-only comparison is genuinely useful.
