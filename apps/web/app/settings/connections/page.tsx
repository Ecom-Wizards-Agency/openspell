/**
 * `/settings/connections` — the Amazon grant, and the result of the last one.
 *
 * This is also the OAuth flow's landing page: the callback redirects here with
 * the per-region counts in the query, so the banner below is the "N profiles
 * per region" result page the brief asks for. Putting it here rather than on a
 * standalone screen means a reload does not lose the connection state, only the
 * banner, which is the right thing to lose.
 */
import type { ReactNode } from 'react';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { listConnections } from '../../../src/data/connections';
import { loadRoster } from '../../../src/data/profiles';
import { Shell } from '../../../src/ui/shell';
import { banner, heading, muted, page, subheading, table, td, th } from '../../../src/ui/tokens';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{
    connected?: string;
    regions?: string;
    failed?: string;
    total?: string;
    oauth_error?: string;
  }>;
}

export default async function ConnectionsPage({ searchParams }: Props): Promise<ReactNode> {
  const query = await searchParams;
  const result = await gate();

  if (result.state === 'no-database') {
    return (
      <main style={page}>
        <h1 style={heading}>Connections</h1>
        <p style={banner('warn')}>
          <code>DATABASE_URL</code> is not set, so this instance cannot read its own database.
        </p>
      </main>
    );
  }
  if (result.state === 'no-org') {
    return (
      <main style={page}>
        <h1 style={heading}>Connections</h1>
        <p style={banner('warn')}>
          Your account is not a member of any organisation yet. There is no self-service
          signup; ask an administrator to add you.
        </p>
      </main>
    );
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const [connections, roster] = await Promise.all([
    listConnections(handle, org.orgId),
    loadRoster(handle, org.orgId),
  ]);
  const mayConnect = can(org.role, 'manageConnection');
  const connected = connections.some((connection) => connection.status === 'active');

  return (
    <main style={page}>
      <Shell context={context} current="connections">
        <h1 style={heading}>Connections</h1>
        <p style={muted}>
          One Amazon Ads authorization per organisation. The refresh token goes straight into
          Supabase Vault; this page never sees it and neither does any other part of the web
          app.
        </p>

        {query.oauth_error ? (
          <p style={banner('bad')} data-testid="oauth-error">
            {query.oauth_error}
          </p>
        ) : null}

        {query.connected ? (
          <div style={banner('good')} data-testid="oauth-result">
            <strong>Connected.</strong>{' '}
            <span data-testid="oauth-total">{query.total ?? '0'}</span> profile(s) landed.
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {parseRegionCounts(query.regions).map(([region, count]) => (
                <li key={region} data-testid={`oauth-region-${region}`}>
                  {region}: {count}
                </li>
              ))}
            </ul>
            {query.failed ? (
              <p style={{ margin: '0.5rem 0 0' }} data-testid="oauth-failed">
                No grant in: {query.failed}. That is normal when the authorization does not
                cover every region.
              </p>
            ) : null}
          </div>
        ) : null}

        <h2 style={subheading}>Amazon Ads</h2>
        {connections.length === 0 ? (
          <p style={muted} data-testid="no-connection">
            Not connected yet.
          </p>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Label</th>
                <th style={th}>Status</th>
                <th style={th}>Credential</th>
                <th style={th}>Profiles</th>
                <th style={th}>Connected</th>
                <th style={th}>Last error</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} data-testid="connection-row">
                  <td style={td}>{connection.label}</td>
                  <td style={td} data-testid="connection-status">
                    {connection.status}
                  </td>
                  <td style={td}>{connection.hasCredential ? 'in Vault' : 'none'}</td>
                  <td style={td}>{connection.profileCount}</td>
                  <td style={td}>{connection.connectedAt ?? '—'}</td>
                  <td style={td}>{connection.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ marginTop: '1rem' }}>
          {mayConnect ? (
            <a href="/api/amazon/oauth/start" data-testid="connect-amazon">
              {connected ? 'Reconnect Amazon Ads' : 'Connect Amazon Ads'}
            </a>
          ) : (
            <span style={muted} data-testid="connect-forbidden">
              Connecting Amazon Ads requires the admin or owner role.
            </span>
          )}
        </p>

        <h2 style={subheading}>More connections</h2>
        <p style={muted}>
          These sources are on the roadmap. The buttons are here so the shape of the product is
          honest about where it is going; the backends are gated behind their own work packages.
        </p>
        <div className="wa-row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            type="button"
            className="wa-btn wa-btn--sm"
            aria-disabled="true"
            disabled
            data-testid="connect-amc"
            title="Amazon Marketing Cloud — coming soon"
          >
            Connect AMC
            <span className="wa-badge" style={{ marginLeft: '0.375rem' }}>
              Coming soon
            </span>
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--sm"
            aria-disabled="true"
            disabled
            data-testid="connect-spapi"
            title="Seller / Vendor Central (SP-API) — coming soon"
          >
            Connect Seller / Vendor Central
            <span className="wa-badge" style={{ marginLeft: '0.375rem' }}>
              Coming soon
            </span>
          </button>
        </div>

        <h2 style={subheading}>Profiles by region</h2>
        {roster.total === 0 ? (
          <p style={muted}>No profiles yet.</p>
        ) : (
          <p style={muted} data-testid="region-summary">
            {Object.entries(roster.regionCounts)
              .map(([region, count]) => `${region}: ${count}`)
              .join(' · ')}{' '}
            · total {roster.total}
          </p>
        )}
      </Shell>
    </main>
  );
}

/** `NA:71,EU:138` back into pairs, ignoring anything that is not that shape. */
function parseRegionCounts(value: string | undefined): [string, string][] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.split(':'))
    .filter((parts): parts is [string, string] => parts.length === 2 && /^\d+$/.test(parts[1] ?? ''))
    .map(([region, count]) => [region, count] as [string, string]);
}
