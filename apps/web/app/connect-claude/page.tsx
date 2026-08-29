/**
 * `/connect-claude` — the AI (MCP) surface.
 *
 * The recon found the incumbent shipping an `AI → MCP` nav item and generating
 * the key itself in settings (`tools/recon/01-navigation-map.md`). WP-09 built
 * our half of that — the `apps/mcp` server and the `mcp.api_keys` model — and
 * left the operator with only a CLI to issue a key. This page is the missing
 * entry: issue a read-only key, see the keys an org already has, and revoke one.
 *
 * Issuing and revoking are gated behind `manageConnection` (owner/admin), the
 * same role that connects Amazon, because a key that reads selected advertising
 * profiles is as sensitive as that grant. Everyone in the org can *see*
 * the roster, so a viewer knows a key exists and who holds what.
 *
 * Entry goes through `gate()`; the key list is scoped by the org it resolves.
 */
import type { ReactNode } from 'react';
import { can } from '../../src/auth/roles';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { mcpEndpoint } from '../../src/env';
import { listMcpKeys } from '../../src/data/mcp-keys';
import { listProfiles } from '../_lib/profiles';
import { ConnectClaudeManager } from './manager';

export const dynamic = 'force-dynamic';

export default async function ConnectClaudePage(): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Connect AI (MCP)" />
        <p className="wa-page-sub">{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const { handle, context } = entry;
  const org = context.active;
  if (!org) return null;

  const [keys, profiles] = await Promise.all([
    listMcpKeys(handle, org.orgId),
    listProfiles(handle, org.orgId),
  ]);
  const canManage = can(org.role, 'manageConnection');
  const endpoint = mcpEndpoint();

  return (
    <main style={page}>
      <PageHeader
        title="Connect AI (MCP)"
        subtitle="Give any MCP client a read-only key to your advertising data over the Model Context Protocol."
      />

      <div className="wa-stack">
        <section className="wa-card">
          <header className="wa-card__head">
            <h2 className="wa-card__title">How it connects</h2>
          </header>
          <div className="wa-card__body">
            <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              <li>Issue a key below and copy it — it is shown once and never stored in full.</li>
              <li>
                Point your client at your MCP endpoint: <code>{endpoint}</code>
              </li>
              <li>
                Store the key in <code>WIZARD_ADS_MCP_TOKEN</code>. The client can then read only
                the profiles selected when the key was issued.
              </li>
            </ol>
            <p className="wa-hint" style={{ marginTop: '0.75rem' }}>
              One key, any MCP client — Claude, Codex, ChatGPT, Cursor or Gemini all connect over the
              same endpoint and bearer token. The setup snippets below reference the environment
              variable by name and never contain its value.
            </p>
            <p className="wa-hint" style={{ marginTop: '0.5rem' }}>
              Every new key is read-only, expires automatically, and has a hard profile allowlist.
              OpenSpell currently exposes no Amazon write tools through MCP.
            </p>
          </div>
        </section>

        <ConnectClaudeManager
          keys={keys}
          profiles={profiles.map((profile) => ({ id: profile.id, label: profile.label }))}
          canManage={canManage}
          role={org.role}
          endpoint={endpoint}
        />
      </div>
    </main>
  );
}
