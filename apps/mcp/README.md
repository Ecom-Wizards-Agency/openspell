# OpenSpell MCP

The production MCP endpoint is a stateless, analytical-read-only view of one
OpenSpell organization. It accepts Streamable HTTP at `POST /mcp`; `GET
/healthz` reports database readiness plus a sanitized Git revision.

The MCP protocol server name and health `service` are `openspell`, and health
also reports `product: "OpenSpell"`. The `@wizard-ads/*` package scope and
`wizardads://` resource URIs remain compatibility identifiers; changing them
would break installed clients without adding an operator capability.

## Usage

Callers authenticate with a revocable, expiring read key. The key can cover all
profiles in its organization or a fixed profile allowlist. Start with
`wizardads://instructions`, then `list_profiles`; never guess a profile id.

The production catalog contains only these analytical tools:

- `list_profiles`, `get_sync_status`, `get_entity_data`
- `query`, `group_by`, `download_data`
- `get_recommendations`, `get_flags`, `get_pacing`
- `list_experiments`, `get_experiment`

Amazon-write stubs and OpenSpell mutation tools are deliberately absent from
discovery. There is no environment switch that can add them accidentally.

## Shape

One authenticated HTTP request creates one MCP server and binds it to a single
organization, key, and profile allowlist. Authentication atomically checks the
token hash, read scope, revocation, and expiry while updating `last_used_at`.
Tools never accept an organization id. Profile reads resolve through the bound
allowlist, so a caller cannot substitute another tenant or profile.

Tool calls and resource list/read operations pass through durable audit wrappers.
Only tool arguments or resource URIs are recorded; transport metadata and bearer
tokens never reach handlers or the audit payload. An audit-write failure fails
the analytical call because an unaudited result cannot support the product's
read-only claim.

The health route runs a database probe. Its response is limited to service name,
version, a validated hexadecimal Git object id (or `unknown`), and database
readiness. Probe errors and configuration values are not returned.

## Design decision

Three shapes were considered:

- A production/development catalog flag was rejected because one bad environment
  value could re-advertise mutation tools.
- A declarative capability registry was rejected because it added a broad public
  policy layer for a catalog with one valid capability class.
- A single analytical catalog was selected. It hides registration and scope
  policy behind the existing server constructor. Runtime configuration cannot
  add mutation tools.

We accept that mutation-tool protocol sketches are no longer discoverable in
exchange for making the deployed capability claim exact. Amazon changes remain
an operator-approved web-and-worker workflow; MCP cannot approve itself.

Deployment and client configuration are in
[`docs/deploy/mcp-evo.md`](../../docs/deploy/mcp-evo.md).
