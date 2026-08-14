/**
 * `/settings/profiles` — the roster, filtered, with the two editable things.
 *
 * Filters are a GET form, so a filtered roster is a URL somebody can send to a
 * colleague. Edits are one small form per row rather than one giant form,
 * because a single form over two hundred profiles submits two hundred rows to
 * change one bid target and makes every save a full-table write.
 *
 * Roles show up twice, and the second time is the one that matters: controls a
 * role cannot use are not rendered, and the server actions behind them check
 * the same capability table anyway.
 */
import type { ReactNode } from 'react';
import { GOAL_LENSES } from '@wizard-ads/core';
import { Region } from '@wizard-ads/shared';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { loadRoster } from '../../../src/data/profiles';
import type { ProfileRow } from '../../../src/data/profiles';
import { Shell } from '../../../src/ui/shell';
import {
  banner,
  button,
  colors,
  heading,
  input,
  muted,
  page,
  table,
  td,
  th,
} from '../../../src/ui/tokens';
import { saveTargets, toggleSync } from './actions';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ region?: string; country?: string; q?: string; sync?: string }>;
}

export default async function ProfilesPage({ searchParams }: Props): Promise<ReactNode> {
  const query = await searchParams;
  const result = await gate();

  if (result.state !== 'ok') {
    return (
      <main style={page}>
        <h1 style={heading}>Profiles</h1>
        <p style={banner('warn')}>
          {result.state === 'no-database'
            ? 'DATABASE_URL is not set, so this instance cannot read its own database.'
            : 'Your account is not a member of any organisation yet.'}
        </p>
      </main>
    );
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const roster = await loadRoster(handle, org.orgId, {
    region: query.region ?? null,
    country: query.country ?? null,
    search: query.q ?? null,
    syncEnabled: query.sync === 'on' ? true : query.sync === 'off' ? false : null,
  });

  const mayEditTargets = can(org.role, 'editTargets');
  const mayToggleSync = can(org.role, 'toggleSync');

  return (
    <main style={page}>
      <Shell context={context} current="profiles">
        <h1 style={heading}>Profiles</h1>
        <p style={muted} data-testid="roster-count">
          Showing {roster.rows.length} of {roster.total}
          {roster.total > 0
            ? ` · ${Object.entries(roster.regionCounts)
                .map(([region, count]) => `${region} ${count}`)
                .join(' · ')}`
            : ''}
        </p>

        <form method="get" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '1rem 0' }}>
          <input
            type="search"
            name="q"
            placeholder="name or profile id"
            defaultValue={query.q ?? ''}
            aria-label="Search profiles"
            style={{ ...input, width: '14rem' }}
          />
          <select name="region" defaultValue={query.region ?? ''} aria-label="Region" style={input}>
            <option value="">All regions</option>
            {Region.options.map((region) => (
              <option key={region} value={region}>
                {region}
              </option>
            ))}
          </select>
          <select name="country" defaultValue={query.country ?? ''} aria-label="Country" style={input}>
            <option value="">All countries</option>
            {roster.countries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
          <select name="sync" defaultValue={query.sync ?? ''} aria-label="Sync state" style={input}>
            <option value="">Any sync state</option>
            <option value="on">Sync on</option>
            <option value="off">Sync off</option>
          </select>
          <button type="submit" style={button}>
            Filter
          </button>
        </form>

        {!mayEditTargets ? (
          <p style={banner('warn')} data-testid="read-only-notice">
            Your role is <strong>{org.role}</strong>: this roster is read-only for you.
          </p>
        ) : null}

        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Profile</th>
              <th style={th}>Region</th>
              <th style={th}>Country</th>
              <th style={th}>Currency</th>
              <th style={th}>Sync</th>
              <th style={th}>Target ACOS %</th>
              <th style={th}>Target TACOS %</th>
              <th style={th}>Goal lens</th>
              <th style={th}>Monthly budget</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {roster.rows.map((profile) => (
              <ProfileTableRow
                key={profile.id}
                profile={profile}
                mayEditTargets={mayEditTargets}
                mayToggleSync={mayToggleSync}
              />
            ))}
          </tbody>
        </table>

        {roster.rows.length === 0 ? (
          <p style={muted} data-testid="roster-empty">
            No profiles match. Connect Amazon Ads, or widen the filter.
          </p>
        ) : null}
      </Shell>
    </main>
  );
}

function ProfileTableRow({
  profile,
  mayEditTargets,
  mayToggleSync,
}: {
  profile: ProfileRow;
  mayEditTargets: boolean;
  mayToggleSync: boolean;
}): ReactNode {
  const formId = `targets-${profile.id}`;
  return (
    <tr data-testid="profile-row" data-profile-id={profile.id}>
      <td style={td}>
        <div>{profile.accountName ?? profile.amazonProfileId}</div>
        <div style={{ ...muted, fontSize: '0.75rem' }}>{profile.amazonProfileId}</div>
      </td>
      <td style={td}>{profile.region}</td>
      <td style={td}>{profile.countryCode}</td>
      <td style={td}>{profile.currencyCode}</td>
      <td style={td} data-testid="sync-state">
        {mayToggleSync ? (
          <form action={toggleSync}>
            <input type="hidden" name="profileId" value={profile.id} />
            <input type="hidden" name="enabled" value={profile.syncEnabled ? '0' : '1'} />
            <button
              type="submit"
              style={{
                ...button,
                color: profile.syncEnabled ? colors.good : colors.muted,
              }}
              data-testid="toggle-sync"
            >
              {profile.syncEnabled ? 'on' : 'off'}
            </button>
          </form>
        ) : (
          <span data-testid="sync-readonly">{profile.syncEnabled ? 'on' : 'off'}</span>
        )}
      </td>
      <td style={td}>
        <Cell
          formId={formId}
          name="targetAcos"
          value={fractionToPercent(profile.targetAcos)}
          editable={mayEditTargets}
        />
      </td>
      <td style={td}>
        <Cell
          formId={formId}
          name="targetTotalAcos"
          value={fractionToPercent(profile.targetTotalAcos)}
          editable={mayEditTargets}
        />
      </td>
      <td style={td}>
        {mayEditTargets ? (
          <select
            form={formId}
            name="goalLens"
            defaultValue={profile.goalLens ?? ''}
            aria-label="Goal lens"
            style={{ ...input, width: '9rem' }}
            data-testid="field-goalLens"
          >
            <option value="">—</option>
            {Object.entries(GOAL_LENSES).map(([key, lens]) => (
              <option key={key} value={key}>
                {lens.label}
              </option>
            ))}
          </select>
        ) : (
          <span data-testid="field-goalLens">{profile.goalLens ?? '—'}</span>
        )}
      </td>
      <td style={td}>
        <Cell
          formId={formId}
          name="monthlyBudget"
          value={profile.monthlyBudget === null ? '' : String(profile.monthlyBudget)}
          editable={mayEditTargets}
        />
      </td>
      <td style={td}>
        {mayEditTargets ? (
          <form action={saveTargets} id={formId}>
            <input type="hidden" name="profileId" value={profile.id} />
            <button type="submit" style={button} data-testid="save-targets">
              Save
            </button>
          </form>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * One number, editable or not.
 *
 * The inputs live outside the `<form>` element and reference it with the `form`
 * attribute, because a form cannot span table cells in valid HTML and a row of
 * inputs that silently fails to submit is a worse bug than a slightly unusual
 * attribute.
 */
function Cell({
  formId,
  name,
  value,
  editable,
}: {
  formId: string;
  name: string;
  value: string;
  editable: boolean;
}): ReactNode {
  if (!editable) {
    return <span data-testid={`field-${name}`}>{value === '' ? '—' : value}</span>;
  }
  return (
    <input
      form={formId}
      name={name}
      type="number"
      step="0.01"
      min="0"
      defaultValue={value}
      aria-label={name}
      style={input}
      data-testid={`field-${name}`}
    />
  );
}

function fractionToPercent(value: number | null): string {
  if (value === null) return '';
  return String(Number((value * 100).toFixed(2)));
}
