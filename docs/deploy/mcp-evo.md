# OpenSpell MCP on Evo X1

OpenSpell MCP runs as one host-local Node service behind one Cloudflare Tunnel
connector. Both processes are locked systemd services. The MCP service listens
only on `127.0.0.1:8787`; Evo X1 exposes no inbound port.

This replaces the former Compose deployment. Docker environment metadata is not
an acceptable secret boundary for the database credential, and persistent
environment files are not used.

## Runtime contract

An external, attended secret workflow must stage two TPM-encrypted systemd
credentials under these runtime IDs:

- `openspell-mcp-database-url`
- `openspell-cloudflare-tunnel-token`

The repository defines the runtime IDs only. It contains no secret value,
1Password item locator, tenant roster, or credential-generation command.
Each `LoadCredentialEncrypted=` directive pins the corresponding path under
`/etc/credstore.encrypted`; no inherited or alternate-store credential can win
lookup precedence. Service startup fails when a credential is missing, empty,
moved to the wrong machine, or encrypted under the wrong logical name.

There is no shared MCP bearer token in the server service. Client API keys stay
client-scoped, are verified through their database hashes, and enter Codex or
Claude only through the `WIZARD_ADS_MCP_TOKEN` environment reference described
below.

The MCP launcher reads the database credential from the service-private
`CREDENTIALS_DIRECTORY`, validates its URL scheme without logging it, and passes
it directly to the Node process. `cloudflared` reads its token through
`--token-file` from its own service-private credential directory. Neither value
is written to a release, environment file, command argument, container, or log.

The remotely managed tunnel route is:

```text
Hostname: mcp.ecomwizards.agency
Service:  http://127.0.0.1:8787
```

The hostname forwards `/healthz` and `/mcp` unchanged. The machine needs
outbound network access only.

## Prerequisites

Before staging a release:

1. Approve one full Git object ID from `origin/main`.
2. Use a clean checkout at that exact revision.
3. Install Node 22 or newer at `/usr/local/bin/node`, the repository-declared pnpm
   version, systemd, `rsync`, and a reviewed `cloudflared` release at
   `/usr/local/bin/cloudflared`. `--token-file` requires cloudflared 2025.4.0 or
   later.
4. Complete the external credential staging above. The installer checks only
   encrypted-file metadata and never decrypts or prints either credential.
5. Confirm the remotely managed tunnel targets the host-local endpoint.
6. From the Cloudflare control plane, create a short-lived, mode-`0600`,
   gitignored `_local/mcp-route-exclusivity.json` record confirming that the
   hostname has one route, zero unmanaged connectors, and that legacy connector
   credentials have been revoked. The record is an attended assertion, not a
   secret, and expires within one hour.

The installer verifies `cloudflared` against an independently approved SHA-256
digest, copies that exact binary into the release, packages MCP with injected
workspace dependencies, normalizes checkout-dependent package metadata, rejects
links back to the checkout, and publishes a reconciled release atomically under
its exact Git object ID.

## Test and stage

Run from the clean checkout. `APPROVED_REVISION` is public release metadata, not
a secret.

```bash
git fetch origin --prune
APPROVED_REVISION="$(git rev-parse HEAD)"
CLOUDFLARED_SHA256="replace-with-approved-lowercase-sha256"
test "$APPROVED_REVISION" = "$(git rev-parse origin/main)"
test -z "$(git status --porcelain --untracked-files=normal)"
bash docs/deploy/test-mcp-evo-systemd.sh
bash docs/deploy/install-mcp-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --cloudflared-sha256 "$CLOUDFLARED_SHA256"
```

Staging installs the release, versioned launchers, and versioned unit files.
It does not modify `/etc/systemd/system`, switch `current`, enable a unit, or
restart a process.

## First cutover from a legacy runtime

Resolve and record every legacy service, container, connector, and route by
exact ID before stopping it. Do not use a broad container name or filesystem
glob. Revoke the legacy connector credential so a stopped artifact cannot
resume and split traffic. Keep other stopped artifacts until the new public and
client checks pass so rollback remains recoverable.

The activation mode refuses to continue while the known legacy Compose project
or legacy MCP system service is still running. It also requires the short-lived
control-plane record because local process checks cannot prove that another
remote connector is absent. Use this exact shape, with current ISO timestamps
and the approved revision; do not add connector IDs, tokens, or account data:

```json
{
  "approvedRevision": "<approved full Git object ID>",
  "expiresAt": "<no more than one hour after verifiedAt>",
  "hostname": "mcp.ecomwizards.agency",
  "legacyConnectorCredentialsRevoked": true,
  "origin": "http://127.0.0.1:8787",
  "routeCount": 1,
  "schemaVersion": 1,
  "unmanagedConnectorCount": 0,
  "verifiedAt": "<current ISO timestamp>"
}
```

After those exact processes are stopped and the record is mode `0600`, activate
the staged release:

```bash
bash docs/deploy/install-mcp-evo-systemd.sh \
  --revision "$APPROVED_REVISION" \
  --cloudflared-sha256 "$CLOUDFLARED_SHA256" \
  --activate \
  --route-exclusivity-record _local/mcp-route-exclusivity.json
```

Activation verifies and installs the unit definitions retained with the release,
atomically switches the `current` symlink, explicitly restarts the MCP service,
waits for exact local health, restarts the tunnel, and then verifies exact
public health. If the new services fail, it stops them and restores both the
previous OpenSpell release link and its retained unit definitions when one
exists. During the first cutover, restart only a separately reviewed legacy
fallback; never reuse a revoked tunnel credential.

The tunnel is ordered after the MCP startup health gate but is not stopped by a
later MCP crash. It remains connected while systemd restarts MCP, so the
host-local origin can recover without a separate tunnel start operation.

Only after all validation below succeeds should the operator disable or remove
the stopped legacy definitions and delete any legacy plaintext credential copy.
Rotate a credential if its provenance cannot be proven.

## Validate the live artifact

```bash
bash docs/deploy/verify-mcp-evo-systemd.sh "$APPROVED_REVISION"
```

The verifier requires both services to be active, proves that the MCP listener
is exclusively host-local, and checks local and public health for all four exact
fields:

```json
{
  "status": "ready",
  "service": "openspell",
  "product": "OpenSpell",
  "revision": "<approved full Git object ID>"
}
```

A database failure must remain HTTP 503 with `status: "not_ready"` and no
connection detail.

Health is necessary but not sufficient. With an expiring, profile-allowlisted
client token supplied as `WIZARD_ADS_MCP_TOKEN`, verify from both Codex and
Claude Code:

1. discovery contains exactly the eleven analytical tools in
   `apps/mcp/README.md` and no Amazon-write or self-approval tool;
2. `list_profiles` returns only allowlisted profiles;
3. one real analytical read matches a trusted SQL count;
4. a disallowed profile has the same not-found shape as an unknown profile;
5. `mcp.api_keys.last_used_at` advances and the audit log records the tool and
   resource actions without a token value.

Codex stores the environment-variable name, not the token:

```bash
codex mcp add openspell \
  --url https://mcp.ecomwizards.agency/mcp \
  --bearer-token-env-var WIZARD_ADS_MCP_TOKEN
codex mcp get openspell
```

Claude Code uses the same private environment reference:

```json
{
  "mcpServers": {
    "openspell": {
      "type": "http",
      "url": "https://mcp.ecomwizards.agency/mcp",
      "headers": {
        "Authorization": "Bearer ${WIZARD_ADS_MCP_TOKEN}"
      }
    }
  }
}
```

## Update and rollback

Stage and activate updates exactly as above. Releases are immutable and retained
by Git object ID. Never overwrite an existing release directory with different
content.

To roll back, resolve the exact retained revision, verify its `REVISION` marker,
then run the guarded rollback with the currently expected revision and the
retained destination:

```bash
bash docs/deploy/rollback-mcp-evo-systemd.sh \
  "$APPROVED_REVISION" \
  "$PRIOR_REVISION"
```

The script refuses stale current state, invalid release or unit markers, or an
unapproved connector binary. It switches the release and its retained unit set,
restarts both services, and verifies the exact public revision. If verification
fails, it restores the original release and original unit set before restarting.
Stop and investigate if any marker, health revision, or public revision differs.

This service has no migration step. An MCP rollback must not modify application
data.

## Credential rotation

The attended secret workflow replaces the relevant TPM-encrypted credential
atomically. Restart only the consumer of the rotated credential:

- database credential: MCP, then tunnel after exact MCP health;
- tunnel credential: tunnel only;
- MCP API key: issue and test a replacement, then revoke the prior key in the
  trusted operator workflow.

Never recover a value from process state, Docker metadata, a legacy file, or a
captured command. Return to the authoritative secret workflow instead.
