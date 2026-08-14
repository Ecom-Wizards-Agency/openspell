'use client';

/**
 * The interactive half of Connect Claude: issue a key, reveal it once, and
 * revoke.
 *
 * The reveal-once panel is load-bearing. The plaintext token is in the issue
 * response and nowhere else — never stored, never re-fetchable — so this
 * component shows it prominently with a copy button and says, in the same
 * breath, that closing the panel is the last time it exists. That is the honest
 * shape of a secret you cannot recover, and it is why the table below shows only
 * a masked prefix.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Field, Input } from '../../src/ui/primitives';
import type { McpKeyRecord } from '../../src/data/mcp-keys';

type Row = McpKeyRecord;

type Status = 'active' | 'revoked' | 'expired';

function statusOf(key: Row): Status {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now()) return 'expired';
  return 'active';
}

function shortDate(iso: string | null): string {
  return iso === null ? '—' : iso.slice(0, 10);
}

export function ConnectClaudeManager({
  keys,
  canManage,
  role,
}: {
  keys: readonly McpKeyRecord[];
  canManage: boolean;
  role: string;
}): ReactNode {
  const [list, setList] = useState<Row[]>([...keys]);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = useCallback(async () => {
    setError(null);
    if (label.trim().length === 0) {
      setError('Give the key a label so you can tell your keys apart.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/mcp-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      });
      const payload = (await response.json()) as { key?: McpKeyRecord; token?: string; error?: string };
      if (!response.ok || payload.key === undefined || payload.token === undefined) {
        throw new Error(payload.error ?? response.statusText);
      }
      setList((current) => [payload.key as McpKeyRecord, ...current]);
      setToken(payload.token);
      setCopied(false);
      setLabel('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The key could not be issued.');
    } finally {
      setBusy(false);
    }
  }, [label]);

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

  const copy = useCallback(async () => {
    if (token === null) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard blocked: the token is still on screen to copy by hand.
    }
  }, [token]);

  return (
    <section className="wa-card">
      <header className="wa-card__head">
        <h2 className="wa-card__title">MCP keys</h2>
        <span className="wa-card__sub">{list.length} issued</span>
      </header>
      <div className="wa-card__body">
        {canManage ? (
          <div className="wa-row" style={{ alignItems: 'flex-end', gap: '0.5rem' }}>
            <Field label="Key label" htmlFor="mcp-key-label" grow>
              <Input
                id="mcp-key-label"
                data-testid="key-label-input"
                value={label}
                placeholder="e.g. Victor's laptop"
                onChange={(event) => setLabel(event.target.value)}
                disabled={busy}
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => void issue()}
              disabled={busy}
              data-testid="issue-key"
            >
              Issue key
            </Button>
          </div>
        ) : (
          <p className="wa-hint" data-testid="issue-forbidden">
            Issuing and revoking keys requires the admin or owner role. Your role is {role}; you can
            see the org&rsquo;s keys but not change them.
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
            <div
              className="wa-row"
              style={{ alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}
            >
              <code data-testid="issued-token" style={{ wordBreak: 'break-all', flex: '1 1 auto' }}>
                {token}
              </code>
              <Button size="sm" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToken(null)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {list.length === 0 ? (
          <p className="wa-hint" style={{ marginTop: '0.75rem' }} data-testid="mcp-key-empty">
            No keys yet. {canManage ? 'Issue one above to connect Claude.' : 'Ask an admin to issue one.'}
          </p>
        ) : (
          <div className="wa-tablewrap" style={{ marginTop: '0.75rem' }}>
            <table className="wa-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Key</th>
                  <th scope="col">Scope</th>
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
                      <td>
                        <code>{key.keyPrefix}…</code>
                      </td>
                      <td>{key.scope}</td>
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
