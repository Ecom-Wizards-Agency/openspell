/** `/settings/integrations` — generic external API credential custody. */
import type { ReactNode } from 'react';
import { listCompetitorLinks, listIntegrationConnections } from '@wizard-ads/db';
import type {
  CompetitorLinkRecord,
  IntegrationConnectionRecord,
  IntegrationConnectionStatus,
  IntegrationProvider,
} from '@wizard-ads/db';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { operatorFailureLabel } from '../../../src/security/operator-failure';
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
import { listProfiles } from '../../_lib/profiles';
import type { ProfileRecord } from '../../_lib/profiles';
import {
  addCompetitorLink,
  connectIntegration,
  deleteCompetitorLink,
  revokeIntegration,
} from './actions';
import { IntegrationSubmitButton } from './submit-button';
import { CompetitorProfileSelect } from './competitor-profile-select';

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
  const [competitorLinks, profiles] = await Promise.all([
    listCompetitorLinks(handle, org.orgId),
    listProfiles(handle, org.orgId),
  ]);
  const mayManage = can(org.role, 'manageConnection');
  const mayEditCompetitors = can(org.role, 'editTargets');

  return (
    <main style={page}>
      <Shell context={context} current="integrations">
        <h1 style={heading}>Integrations</h1>
        <p style={muted}>
          Add external API credentials once. Values go directly to Supabase Vault and are
          never displayed again; this page shows only provider, label, connection state and
          operator-safe health summaries.
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
            >
              {provider.id === 'keepa' ? (
                <CompetitorLinksSection
                  links={competitorLinks}
                  profiles={profiles}
                  mayEdit={mayEditCompetitors}
                />
              ) : null}
            </ProviderCard>
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
  children,
}: {
  provider: (typeof PROVIDERS)[number];
  connections: readonly IntegrationConnectionRecord[];
  mayManage: boolean;
  children?: ReactNode;
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
                  <td>{operatorFailureLabel(connection.lastError) ?? '—'}</td>
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
          <IntegrationSubmitButton providerId={provider.id} providerName={provider.name} />
        </form>
      ) : null}
      {children}
    </Card>
  );
}

function CompetitorLinksSection({
  links,
  profiles,
  mayEdit,
}: {
  links: readonly CompetitorLinkRecord[];
  profiles: readonly ProfileRecord[];
  mayEdit: boolean;
}): ReactNode {
  return (
    <section style={{ borderTop: '1px solid var(--wa-border)', marginTop: '1.25rem', paddingTop: '1rem' }}>
      <h3 style={{ margin: 0 }}>Competitor ASINs</h3>
      <p className="wa-hint">
        Link each advertised ASIN to a competitor in the same marketplace. Analysts may edit these pairs.
      </p>
      {links.length > 0 ? (
        <TableFrame>
          <table className="wa-table">
            <thead><tr><th>Profile</th><th>Our ASIN</th><th>Competitor ASIN</th>{mayEdit ? <th>Action</th> : null}</tr></thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id} data-testid="competitor-link-row">
                  <td>{link.profileLabel ?? 'Unscoped'}{link.marketplace ? ` · ${link.marketplace}` : ''}</td>
                  <td><code>{link.ourAsin}</code></td>
                  <td><code>{link.competitorAsin}</code></td>
                  {mayEdit ? (
                    <td>
                      <form action={deleteCompetitorLink}>
                        <input type="hidden" name="linkId" value={link.id} />
                        <Button type="submit" variant="danger" size="sm">Remove</Button>
                      </form>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      ) : <p className="wa-hint" data-testid="competitor-links-empty">No competitor pairs yet.</p>}

      {mayEdit && profiles.length > 0 ? (
        <form action={addCompetitorLink} className="wa-row" style={{ alignItems: 'end', gap: '0.75rem', marginTop: '1rem' }}>
          <CompetitorProfileSelect profiles={profiles} />
          <Field label="Our ASIN" htmlFor="our-asin">
            <Input id="our-asin" name="ourAsin" required minLength={10} maxLength={10} autoCapitalize="characters" />
          </Field>
          <Field label="Competitor ASIN" htmlFor="competitor-asin">
            <Input id="competitor-asin" name="competitorAsin" required minLength={10} maxLength={10} autoCapitalize="characters" />
          </Field>
          <Button type="submit">Add pair</Button>
        </form>
      ) : null}
    </section>
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
