# MCP on Evo X1 through Cloudflare Tunnel

This is the operator runbook for the read-only MCP service at
`https://mcp.ecomwizards.agency/mcp`. It runs the Node 22 application and
`cloudflared` as restartable containers on Evo X1. It does not use Fly.io,
Cloudflare Workers compute, or an inbound host port.

This package prepares deployment but does not authorize one. The operator must
approve the exact release commit and target host before these steps run.

## Runtime inputs

Keep all runtime values outside the checkout. The compose template references
them; it does not contain them.

- `WIZARD_ADS_MCP_ENV_FILE`: path to a mode-`0600` environment file created by
  the host's secret manager. It supplies `WIZARD_ADS_MCP_DATABASE_URL` and any
  non-secret pool/timeout/row-limit overrides.
- `WIZARD_ADS_MCP_CLOUDFLARED_TOKEN_FILE`: path to a mode-`0600` file containing
  only the remotely managed tunnel token.
- `WIZARD_ADS_CLOUDFLARED_UID`: numeric host UID that owns the tunnel-token file.
- `WIZARD_ADS_CLOUDFLARED_GID`: numeric host GID that owns the tunnel-token file.
- `WIZARD_ADS_MCP_REVISION`: the full approved Git object id.
- `WIZARD_ADS_CLOUDFLARED_IMAGE`: optional approved image tag or digest. When it
  is omitted, Compose uses Cloudflare's `latest` image; pin a reviewed digest for
  a controlled production rollout.

Never place either protected file in the repository, paste their contents into a
shell command, or print them in a deployment log. The tunnel token is sufficient
to run a connector and must be rotated if exposed.

Keep the tunnel-token file at mode `0600`. Compose bind-mounts a file-backed
secret without changing its host ownership, so the `cloudflared` container runs
as the explicitly supplied owner UID and GID. Set both values from the account
that owns the protected file; do not assume that the image's default user has the
same numeric identity. Before deployment, verify metadata without reading the
file contents:

```bash
test "$(stat -c '%a' "$WIZARD_ADS_MCP_CLOUDFLARED_TOKEN_FILE")" = "600"
test "$(stat -c '%u' "$WIZARD_ADS_MCP_CLOUDFLARED_TOKEN_FILE")" = "$WIZARD_ADS_CLOUDFLARED_UID"
test "$(stat -c '%g' "$WIZARD_ADS_MCP_CLOUDFLARED_TOKEN_FILE")" = "$WIZARD_ADS_CLOUDFLARED_GID"
```

## Cloudflare preparation

Create one remotely managed tunnel in Cloudflare Zero Trust. Configure its
published application route as:

```text
Hostname: mcp.ecomwizards.agency
Service:  http://mcp:8787
```

The hostname must forward `/mcp` and `/healthz` unchanged. Evo X1 needs outbound
connectivity to Cloudflare; it needs no inbound firewall opening. Cloudflare's
current documentation recommends remotely managed tunnels, and `token-file`
requires `cloudflared` 2025.4.0 or newer:

- https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/
- https://developers.cloudflare.com/tunnel/advanced/run-parameters/

## Build and start

From the clean checkout at the approved revision, set the six non-secret
deployment references above in the operator environment. Validate the rendered
configuration before creating containers:

```bash
bash docs/deploy/check-mcp-evo-compose.sh
docker compose -f docs/deploy/mcp-evo.compose.yaml config --quiet
docker compose -f docs/deploy/mcp-evo.compose.yaml build --pull mcp
docker compose -f docs/deploy/mcp-evo.compose.yaml up -d
docker compose -f docs/deploy/mcp-evo.compose.yaml ps
```

Do not use `docker compose config` without `--quiet` in captured logs: expanded
environment-file values may be rendered by some Compose versions.

The MCP container becomes healthy only when its database probe succeeds.
`cloudflared` waits for that state, then connects using the read-only secret
mount at `/run/secrets/tunnel-token`. Its runtime UID and GID match the protected
file owner, so mode `0600` remains sufficient. Both services use
`restart: unless-stopped`.

## Validate the deployment

Health is public and contains controlled metadata only:

```bash
curl --fail --silent --show-error https://mcp.ecomwizards.agency/healthz
```

Confirm the response says `ready`, identifies `wizard-ads`, and carries the exact
approved revision. A database failure must return HTTP 503 with `not_ready` and
no connection detail.

Issue a read-only, expiring, profile-allowlisted key through the existing trusted
operator workflow. Store it in the client environment as
`WIZARD_ADS_MCP_TOKEN`; never put its value in a command, repository file, or
client setup snippet.

### Codex

Codex supports a bearer-token environment-variable reference for Streamable
HTTP MCP servers. With `WIZARD_ADS_MCP_TOKEN` already supplied by the operator's
secret/session manager:

```bash
codex mcp add wizard-ads \
  --url https://mcp.ecomwizards.agency/mcp \
  --bearer-token-env-var WIZARD_ADS_MCP_TOKEN
codex mcp get wizard-ads
```

This stores the environment variable name, not its value. The official OpenAI
MCP configuration reference documents `bearer_token_env_var`:
https://developers.openai.com/codex/mcp

### Claude Code

Claude Code expands environment variables in HTTP headers. Add this entry to a
private or approved project MCP configuration; it contains only a reference:

```json
{
  "mcpServers": {
    "wizard-ads": {
      "type": "http",
      "url": "https://mcp.ecomwizards.agency/mcp",
      "headers": {
        "Authorization": "Bearer ${WIZARD_ADS_MCP_TOKEN}"
      }
    }
  }
}
```

Use `claude mcp get wizard-ads` and `/mcp` to confirm the connection. Claude
Code's official MCP documentation describes environment expansion in `headers`:
https://code.claude.com/docs/en/mcp

For each client, verify in this order:

1. Discovery contains exactly the eleven analytical tools documented in
   `apps/mcp/README.md`; it contains no Amazon-write stub, deep-link mutation, or
   feedback mutation.
2. `list_profiles` returns only profiles on the key allowlist.
3. One real analytical read returns the expected count against a trusted SQL
   crosscheck.
4. A profile outside the allowlist returns the same not-found shape as an
   unknown profile.
5. `mcp.api_keys.last_used_at` advances and `public.audit_log` contains the tool
   and resource-read actions for that key, with no token value.

## Update, rollback, and token rotation

For an update, check out the approved commit, update
`WIZARD_ADS_MCP_REVISION`, rebuild `mcp`, and run `up -d`. Re-run every validation
above; do not infer readiness from container state alone.

For rollback, check out the prior approved commit and rebuild. This service has
no migration step, so rollback must not modify production data.

Rotate the Cloudflare tunnel token in Zero Trust, replace the protected token
file through the host secret manager, and recreate only `cloudflared`. Rotate an
MCP API key by issuing a replacement, testing it, then revoking the prior key.
Neither token is recoverable from this repository.
