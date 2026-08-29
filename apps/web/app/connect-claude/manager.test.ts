import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  claudeSnippet,
  codexSnippet,
  ConnectClaudeManager,
} from './manager';

const ENDPOINT = 'https://mcp.ecomwizards.agency/mcp';

describe('Connect AI setup safety', () => {
  it('generates secret-free Claude and Codex setup for the exact production endpoint', () => {
    const secretValue = ['one-time', '-synthetic', '-secret'].join('');
    const claude = claudeSnippet(ENDPOINT);
    const codex = codexSnippet(ENDPOINT);

    expect(claude).toContain(ENDPOINT);
    expect(claude).toContain('"openspell"');
    expect(claude).not.toContain('"wizard-ads"');
    expect(claude).toContain('Bearer ${WIZARD_ADS_MCP_TOKEN}');
    expect(codex).toContain(`--url ${ENDPOINT}`);
    expect(codex).toContain('codex mcp add openspell');
    expect(codex).not.toContain('codex mcp add wizard-ads');
    expect(codex).toContain('--bearer-token-env-var WIZARD_ADS_MCP_TOKEN');
    expect(codex.split('\n').every((line) => !line.startsWith('+'))).toBe(true);
    expect(`${claude}\n${codex}`).not.toContain(secretValue);
  });

  it('renders bounded expiry, an explicit profile choice, and legacy key scope honestly', () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    const markup = renderToStaticMarkup(
      createElement(ConnectClaudeManager, {
        keys: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            label: 'Older key',
            keyPrefix: 'masked',
            scope: 'read',
            profileIds: null,
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            createdAt: '2026-08-01T00:00:00.000Z',
          },
        ],
        profiles: [{ id: profileId, label: 'Synthetic profile' }],
        canManage: true,
        role: 'owner',
        endpoint: ENDPOINT,
      }),
    );

    expect(markup).toContain('data-testid="profile-allowlist"');
    expect(markup).toContain(`data-testid="profile-option-${profileId}"`);
    expect(markup).toContain('value="30" selected=""');
    expect(markup).toContain('Legacy: all profiles');
    expect(markup).toContain('WIZARD_ADS_MCP_TOKEN');
    expect(markup).not.toContain('org-wide');
  });
});
