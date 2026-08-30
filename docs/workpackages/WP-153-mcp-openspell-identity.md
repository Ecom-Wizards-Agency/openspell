# WP-153 — MCP OpenSpell identity

## Outcome

Align the MCP protocol and public health metadata with the OpenSpell product
name without breaking installed clients or changing the tool catalog.

## Compatibility boundary

- The MCP initialize response names the server `openspell`.
- `GET /healthz` reports `service: "openspell"`, `product: "OpenSpell"`, the
  existing version, a sanitized Git revision, and database readiness only.
- Authentication challenges use the `openspell` bearer realm.
- The published endpoint, `@wizard-ads/*` package scope, environment-variable
  names, and `wizardads://` resource URIs remain stable compatibility IDs.
- The production catalog remains analytical and read-only. This package adds
  no tool, database query, Amazon call, mutation path, deployment action, or
  credential handling.

## Verification

- Health tests assert the exact ready and not-ready payloads.
- Authentication tests assert the exact OpenSpell bearer realm.
- MCP transport and database-backed suites continue to prove discovery,
  profile allowlists, expiry/revocation, audit logging, and `last_used_at`.
- Deployment remains a separate exact-revision gate; source changes alone do
  not prove that the always-on service was upgraded.
