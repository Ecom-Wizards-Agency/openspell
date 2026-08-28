'use client';

/**
 * Issue expiring, profile-allowlisted MCP keys and reveal each plaintext once.
 * Connection snippets are deliberately independent of the issued token: they
 * persist only the `WIZARD_ADS_MCP_TOKEN` environment-variable reference.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Checkbox, Field, Input, Select } from '../../src/ui/primitives';
import {
  DEFAULT_MCP_KEY_EXPIRY_DAYS,
  MCP_KEY_EXPIRY_DAY_OPTIONS,
} from '../../src/mcp-key-policy';
import type { McpKeyRecord } from '../../src/data/mcp-keys';

type Row = McpKeyRecord;
type Status = 'active' | 'revoked' | 'expired';

export interface McpProfileOption {
  id: string;
  label: string;
}

function statusOf(key: Row): Status {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now()) return 'expired';
  return 'active';
}

function shortDate(iso: string | null): string {
  return iso === null ? '—' : iso.slice(0, 10);
}

/** Claude configuration stores the variable reference, never its value. */
export function claudeSnippet(endpoint: string): string {
  return [
    '{',
    '  "mcpServers": {',
    '    "wizard-ads": {',
    '      "type": "http",',
    `      "url": "${endpoint}",`,
    '      "headers": {',
    '        "Authorization": "Bearer ${WIZARD_ADS_MCP_TOKEN}"',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

/** Codex persists only the environment-variable name through its supported flag. */
export function codexSnippet(endpoint: string): string {
  return [
    'codex mcp add wizard-ads \\',
    `  --url ${endpoint} \\`,
    '  --bearer-token-env-var WIZARD_ADS_MCP_TOKEN',
  ].join('\n');
}

function profileScope(key: Row, profiles: readonly McpProfileOption[]): string {
  if (key.profileIds === null) return 'Legacy: all profiles';
  if (key.profileIds.length === 0) return 'No profiles';
  return key.profileIds
    .map((id) => profiles.find((profile) => profile.id === id)?.label ?? 'Unavailable profile')
    .join(', ');
}

function Snippet({
  testId,
  title,
  hint,
  code,
  copied,
  onCopy,
}: {
  testId: string;
  title: string;
  hint: ReactNode;
  code: string;
  copied: boolean;
  onCopy: () => void;
}): ReactNode {
  return (
    <div style={{ marginTop: '0.75rem' }} data-testid={testId}>
      <div className="wa-row" style={{ alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
        <span className="wa-label">
          {title} <span className="wa-hint" style={{ fontWeight: 400 }}>{hint}</span>
        </span>
        <Button size="sm" onClick={onCopy} data-testid={`copy-${testId}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        className="wa-code"
        style={{
          marginTop: '0.375rem',
          marginBottom: 0,
          padding: '0.625rem 0.75rem',
          overflowX: 'auto',
          background: 'var(--wa-surface)',
          border: '1px solid var(--wa-border-strong)',
          borderRadius: 'var(--wa-radius)',
        }}
      >
        <code data-testid={`${testId}-code`} style={{ whiteSpace: 'pre', fontSize: 'var(--wa-fs-xs)' }}>
          {code}
        </code>
      </pre>
    </div>
  );
}

export function ConnectClaudeManager({
  keys,
  profiles,
  canManage,
  role,
  endpoint,
}: {
  keys: readonly McpKeyRecord[];
  profiles: readonly McpProfileOption[];
  canManage: boolean;
  role: string;
  endpoint: string;
}): ReactNode {
  const [list, setList] = useState<Row[]>([...keys]);
  const [label, setLabel] = useState('');
  const [profileIds, setProfileIds] = useState<string[]>(
    profiles.length === 1 ? [profiles[0]?.id ?? ''] : [],
  );
  const [expiresInDays, setExpiresInDays] = useState(DEFAULT_MCP_KEY_EXPIRY_DAYS);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const issue = useCallback(async () => {
    setError(null);
    if (label.trim().length === 0) {
      setError('Give the key a label so you can tell your keys apart.');
      return;
    }
    if (profileIds.length === 0) {
      setError('Select at least one profile for this key.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/mcp-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), profileIds, expiresInDays }),
      });
      const payload = (await response.json()) as { key?: McpKeyRecord; token?: string; error?: string };
      if (!response.ok || payload.key === undefined || payload.token === undefined) {
        throw new Error(payload.error ?? response.statusText);
      }
      setList((current) => [payload.key as McpKeyRecord, ...current]);
      setToken(payload.token);
      setCopiedId(null);
      setLabel('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The key could not be issued.');
    } finally {
      setBusy(false);
    }
  }, [expiresInDays, label, profileIds]);

  const toggleProfile = useCallback((profileId: string) => {
    setProfileIds((current) =>
      current.includes(profileId)
        ? current.filter((candidate) => candidate !== profileId)
        : [...current, profileId],
    );
  }, []);

  const revoke = useCallback(async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/mcp-keys/${id}/revoke`, { method: 'POST' });
      const payload = (await response.json()) as { revoked?: boolean; error?: string };
      if (!response.ok || payload.revoked !== true) {
        throw new Error(payload.error ?? response.statusText);
      }
      setList((current) =>
        current.map((key) => (key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The key could not be revoked.');
    } finally {
      setBusy(false);
    }
  }, []);

  const copyText = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
    } catch {
      // Clipboard blocked: the text is still on screen to copy by hand.
    }
  }, []);

  return (
    <section className="wa-card">
      <header className="wa-card__head">
        <h2 className="wa-card__title">MCP keys</h2>
        <span className="wa-card__sub">{list.length} issued</span>
      </header>
      <div className="wa-card__body">
        {canManage ? (
          <div className="wa-stack" style={{ gap: '0.75rem' }}>
            <div className="wa-row" style={{ alignItems: 'flex-end', gap: '0.5rem' }}>
              <Field label="Key label" htmlFor="mcp-key-label" grow>
                <Input
                  id="mcp-key-label"
                  data-testid="key-label-input"
                  value={label}
                  placeholder="e.g. Laptop — Claude Code"
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field label="Expires after" htmlFor="mcp-key-expiry">
                <Select
                  id="mcp-key-expiry"
                  data-testid="key-expiry-select"
                  value={expiresInDays}
                  onChange={(event) => setExpiresInDays(Number(event.target.value))}
                  disabled={busy}
                >
                  {MCP_KEY_EXPIRY_DAY_OPTIONS.map((days) => (
                    <option key={days} value={days}>{days} days</option>
                  ))}
                </Select>
              </Field>
              <Button onClick={() => void issue()} disabled={busy || profiles.length === 0} data-testid="issue-key">
                Issue key
              </Button>
            </div>
            <fieldset
              style={{ margin: 0, padding: '0.625rem 0.75rem', border: '1px solid var(--wa-border)' }}
              data-testid="profile-allowlist"
            >
              <legend className="wa-label">Profiles this key may read</legend>
              {profiles.length === 0 ? (
                <p className="wa-hint" style={{ margin: 0 }}>
                  Connect an advertising profile before issuing an MCP key.
                </p>
              ) : (
                <div className="wa-row" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
                  {profiles.map((profile) => (
                    <label key={profile.id} className="wa-row" style={{ gap: '0.375rem' }}>
                      <Checkbox
                        checked={profileIds.includes(profile.id)}
                        onChange={() => toggleProfile(profile.id)}
                        disabled={busy}
                        data-testid={`profile-option-${profile.id}`}
                      />
                      <span>{profile.label}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="wa-hint" style={{ margin: '0.5rem 0 0' }}>
                At least one profile is required. The allowlist is enforced on every MCP read.
              </p>
            </fieldset>
          </div>
        ) : (
          <p className="wa-hint" data-testid="issue-forbidden">
            Issuing and revoking keys requires the admin or owner role. Your role is {role}; you can
            see issued key metadata but not change it.
          </p>
        )}

        {error === null ? null : (
          <p className="wa-banner wa-banner--bad" role="alert" style={{ marginTop: '0.75rem' }} data-testid="mcp-error">
            {error}
          </p>
        )}

        {token === null ? null : (
          <div className="wa-banner wa-banner--good" style={{ display: 'block', marginTop: '0.75rem' }}>
            <strong>Copy this key now — it is shown once and cannot be retrieved.</strong>
            <div className="wa-row" style={{ alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <code data-testid="issued-token" style={{ wordBreak: 'break-all', flex: '1 1 auto' }}>
                {token}
              </code>
              <Button size="sm" onClick={() => void copyText('token', token)}>
                {copiedId === 'token' ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToken(null)}>Done</Button>
            </div>
            <p className="wa-hint" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
              Store this value in <code>WIZARD_ADS_MCP_TOKEN</code> in your client&rsquo;s private
              environment. The reusable setup snippets below never include the value.
            </p>
          </div>
        )}

        <div style={{ marginTop: '0.875rem', paddingTop: '0.125rem' }}>
          <p className="wa-hint" style={{ margin: 0 }}>
            Set <code>WIZARD_ADS_MCP_TOKEN</code> privately before using either setup. These
            instructions contain the variable name only.
          </p>
          <Snippet
            testId="claude-snippet"
            title="Claude Code"
            hint="Add this HTTP server to your private MCP configuration:"
            code={claudeSnippet(endpoint)}
            copied={copiedId === 'claude'}
            onCopy={() => void copyText('claude', claudeSnippet(endpoint))}
          />
          <Snippet
            testId="codex-snippet"
            title="Codex"
            hint="Run after the environment variable is available:"
            code={codexSnippet(endpoint)}
            copied={copiedId === 'codex'}
            onCopy={() => void copyText('codex', codexSnippet(endpoint))}
          />
        </div>

        {list.length === 0 ? (
          <p className="wa-hint" style={{ marginTop: '0.75rem' }} data-testid="mcp-key-empty">
            No keys yet. {canManage ? 'Issue one above to connect your AI client.' : 'Ask an admin to issue one.'}
          </p>
        ) : (
          <div className="wa-tablewrap" style={{ marginTop: '0.75rem' }}>
            <table className="wa-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Key</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Profiles</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Status</th>
                  {canManage ? <th scope="col">Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((key) => {
                  const status = statusOf(key);
                  return (
                    <tr key={key.id} data-testid="key-row" data-key-id={key.id}>
                      <td>{key.label}</td>
                      <td><code>{key.keyPrefix}…</code></td>
                      <td>{key.scope}</td>
                      <td>{profileScope(key, profiles)}</td>
                      <td>{shortDate(key.expiresAt)}</td>
                      <td>{shortDate(key.createdAt)}</td>
                      <td>{shortDate(key.lastUsedAt)}</td>
                      <td>
                        <Badge tone={status === 'active' ? 'good' : status === 'expired' ? 'warn' : 'neutral'}>
                          {status}
                        </Badge>
                      </td>
                      {canManage ? (
                        <td>
                          {status === 'revoked' ? (
                            <span className="wa-hint">revoked</span>
                          ) : (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => void revoke(key.id)}
                              disabled={busy}
                              data-testid={`revoke-key-${key.id}`}
                            >
                              Revoke
                            </Button>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
