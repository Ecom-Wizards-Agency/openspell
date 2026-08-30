# WP-157 — OpenSpell MCP Evo systemd runtime

## Objective

Replace the overlapping Compose and local-service deployment descriptions with
one reproducible, repository-owned OpenSpell MCP topology on Evo X1.

## Scope

- `docs/deploy/mcp-evo.md`
- `docs/deploy/openspell-mcp.service`
- `docs/deploy/openspell-mcp-tunnel.service`
- MCP-only install, launch, health, rollback, verification, and invariant scripts in
  `docs/deploy/`
- removal of the superseded MCP Compose definition and its checker

No MCP application, web, worker, database, shared contract, sibling repository,
1Password item, host service, or live credential is changed by this package.

## Design

- MCP runs as a dynamic systemd user on `127.0.0.1:8787`.
- A second dynamic-user unit runs the remotely managed Cloudflare Tunnel after
  MCP passes startup health; it remains available while MCP automatically
  recovers from a later crash.
- Database and tunnel credentials arrive only through
  `LoadCredentialEncrypted=` runtime IDs.
- The installer packages a path-independent, immutable root-owned release from
  an exact clean Git revision, retains its exact systemd unit set and reviewed
  connector binary, includes its TypeScript runtime, reconciles artifact counts,
  and atomically publishes only a complete release.
- Exact local health gates the tunnel; exact public health gates activation.
- Health must report `ready`, `openspell`, `OpenSpell`, and the approved full
  revision.
- Activation requires a short-lived attended route-exclusivity record, refuses
  known local legacy overlap, and restores the prior OpenSpell release and unit
  definitions on failure.

## Acceptance evidence

- shell and Node syntax checks pass;
- executable invariant tests prove pinned credential routing, host-local binding,
  systemd hardening, path-independent packaging, absence of inline secret routes,
  versioned unit/connector rollback, and exact health identity;
- the legacy Compose deployment files are absent;
- `pnpm hygiene` passes;
- the branch diff contains no home path, credential value, tenant data,
  1Password item locator, or private company material;
- no service is installed, enabled, stopped, restarted, or contacted with a
  credential during package verification.

## External gates

Deployment remains blocked until the attended host secret workflow stages both
TPM-encrypted runtime credentials under the documented IDs and a reviewed
`cloudflared` binary is installed. First cutover also requires the operator to
record and stop the exact legacy artifacts, revoke their connector credential,
and attest current control-plane route exclusivity in a short-lived gitignored
record so rollback stays recoverable without allowing split traffic.
