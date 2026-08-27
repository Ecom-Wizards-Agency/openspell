/** `/settings/integrations` — generic external API credential custody. */
import type { ReactNode } from 'react';
import { listIntegrationConnections } from '@wizard-ads/db';
import type {
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  IntegrationProvider,
} from '@wizard-ads/db';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { Shell } from '../../../src/ui/shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  TableFrame,
} from '../../../src/ui/primitives';
import { heading, muted, page } from '../../../src/ui/tokens';
import { connectIntegration, revokeIntegration } from './actions';

export const dynamic = 'force-dynamic';

const PROVIDERS: readonly {
  id: IntegrationProvider;
  name: string;
  secretLabel: string;
}[] = [
  { id: 'keepa', name: 'Keepa', secretLabel: 'API key' },
  { id: 'datadive', name: 'DataDive', secretLabel: 'API key' },
  { id: 'mrp', name: 'My Real Profit', secretLabel: 'API credential' },
];

export default async function IntegrationsPage(): Promise<ReactNode> {
  const result = await gate();

  if (result.state === 'no-database') {
    return (
      <main style={page}>
        <h1 style={heading}>Integrations</h1>
        <Banner tone="warn">
          <code>DATABASE_URL</code> is not set, so this instance cannot read its own database.
        </Banner>
      </main>
    );
  }
  if (result.state === 'no-org') {
    return (
      <main style={page}>
        <h1 style={heading}>Integrations</h1>
        <Banner tone="warn">
          Your account is not a member of any organisation yet. Ask an administrator to add
          you before connecting an integration.
        </Banner>
      </main>
    );
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const connections = await listIntegrationConnections(handle, org.orgId);
  const mayManage = can(org.role, 'manageConnection');

  return (
    <main style={page}>
      <Shell context={context} current="integrations">
        <h1 style={heading}>Integrations</h1>
        <p style={muted}>
          Add external API credentials once. Values go directly to Supabase Vault and are
          never displayed again; this page shows only provider, label and connection state.
        </p>

        {!mayManage ? (
          <Banner tone="warn" data-testid="integrations-read-only">
            Connecting or revoking an integration requires the admin or owner role.
          </Banner>
        ) : null}

        <div style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
          {PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              connections={connections.filter((connection) => connection.provider === provider.id)}
              mayManage={mayManage}
            />
          ))}
        </div>
      </Shell>
    </main>
  );
}

function ProviderCard({
  provider,
  connections,
  mayManage,
}: {
  provider: (typeof PROVIDERS)[number];
  connections: readonly IntegrationConnectionRecord[];
  mayManage: boolean;
}): ReactNode {
  return (
    <Card
      title={provider.name}
      subtitle={`Credentials are stored per organisation for ${provider.name}.`}
      aria-label={`${provider.name} integration`}
    >
      {connections.length === 0 ? (
        <p className="wa-hint" data-testid={`integration-empty-${provider.id}`}>
          Not connected yet.
        </p>
      ) : (
        <TableFrame>
          <table className="wa-table">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Status</th>
                <th scope="col">Connected</th>
                <th scope="col">Last error</th>
                {mayManage ? <th scope="col">Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr
                  key={connection.id}
                  data-testid={`integration-row-${provider.id}`}
                >
                  <td>{connection.label}</td>
                  <td>
                    <Badge tone={statusTone(connection.status)} dot>
                      {connection.status}
                    </Badge>
                  </td>
                  <td>{formatTimestamp(connection.connectedAt)}</td>
                  <td>{connection.lastError ?? '—'}</td>
                  {mayManage ? (
                    <td>
                      <form action={revokeIntegration}>
                        <input type="hidden" name="connectionId" value={connection.id} />
                        <Button
                          type="submit"
                          variant="danger"
                          size="sm"
                          data-testid={`revoke-integration-${provider.id}`}
                          disabled={connection.status === 'revoked'}
                        >
                          Revoke
                        </Button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}

      {mayManage ? (
        <form
          action={connectIntegration}
          className="wa-row"
          style={{ alignItems: 'end', gap: '0.75rem', marginTop: '1rem' }}
          data-testid={`connect-integration-${provider.id}`}
        >
          <input type="hidden" name="provider" value={provider.id} />
          <Field
            label="Label (optional)"
            htmlFor={`${provider.id}-label`}
            hint="Defaults to “Default”."
          >
            <Input
              id={`${provider.id}-label`}
              name="label"
              autoComplete="off"
              data-testid={`integration-label-${provider.id}`}
            />
          </Field>
          <Field label={provider.secretLabel} htmlFor={`${provider.id}-secret`} grow>
            <Input
              id={`${provider.id}-secret`}
              type="password"
              name="secret"
              required
              autoComplete="new-password"
              data-testid={`integration-secret-${provider.id}`}
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            data-testid={`submit-integration-${provider.id}`}
          >
            Connect {provider.name}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

function statusTone(
  status: IntegrationConnectionStatus,
): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'active') return 'good';
  if (status === 'error') return 'bad';
  if (status === 'pending') return 'warn';
  return 'neutral';
}

function formatTimestamp(value: Date | null): string {
  if (!value) return '—';
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
