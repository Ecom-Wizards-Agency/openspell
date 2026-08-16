/**
 * `/grid` — the entity grid.
 *
 * The server loads the **whole** result set for the selected entity level and
 * period and ships it to the client in one payload. That is not an oversight;
 * it is the product decision the recon argues for at length
 * (`02-data-grid.md` §6): QA-ing an optimization means sorting four thousand
 * rows by spend, filtering to one change reason and scanning. Server-side
 * pagination makes that workflow physically impossible, and every bulksheet-
 * based competitor loses on exactly this.
 *
 * The cap is 50k rows. Past it the page says the set is truncated rather than
 * quietly showing a prefix, because a total computed over an unmarked prefix is
 * the kind of wrong number that gets quoted on a client call.
 *
 * Entry goes through `gate()`, the same guard `/settings` uses: anonymous
 * visitors are sent to `/login`, and both the roster and the rows are scoped by
 * the org the gate resolved rather than by a profile id anybody could paste.
 */
import type { CSSProperties } from 'react';
import {
  ENTITY_LABELS,
  ENTITY_LEVELS,
  assessFreshness,
  formatInteger,
  tokens,
} from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { loadReportLedger } from '../_lib/dashboard-data';
import { withDatabase } from '../_lib/db';
import { ROW_CAP, loadGridRows } from '../_lib/grid-data';
import { periodFromParams, precedingPeriod, todayIso } from '../_lib/periods';
import { listProfiles, selectProfile } from '../_lib/profiles';
import { GridWorkspace } from './grid-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; entity?: string; from?: string; to?: string }>;
}

function parseEntity(value: string | undefined): EntityLevel {
  return ENTITY_LEVELS.includes(value as EntityLevel) ? (value as EntityLevel) : 'search_terms';
}

export default async function GridPage({ searchParams }: PageProps) {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p style={muted}>{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const orgId = entry.context.active?.orgId ?? '';

  const params = await searchParams;
  const entity = parseEntity(params.entity);
  const period = periodFromParams(params, todayIso());
  const comparison = precedingPeriod(period);

  const data = await withDatabase(async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = selectProfile(profiles, params.profile);
    if (profile === null) return { profiles, profile: null };

    const [payload, ledger, crosscheck] = await Promise.all([
      loadGridRows(handle, entity, {
        orgId,
        profileId: profile.id,
        currencyCode: profile.currencyCode,
        period,
        comparison,
      }),
      loadReportLedger(handle, orgId, profile.id),
      loadCrosscheckPanel(handle, { profileId: profile.id }).catch(() => null),
    ]);

    return { profiles, profile, payload, ledger, crosscheck };
  });

  if (data === null) {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p style={muted}>{gateMessage('no-database')}</p>
      </main>
    );
  }

  if (data.profile === null) {
    return (
      <main style={main}>
        <h1 style={heading}>Grid</h1>
        <p className="wa-page-sub">
          {data.profiles.length === 0
            ? 'No advertising profiles yet. Connect an account and enable sync on a profile to see one here.'
            : 'Choose an advertising profile from the switcher in the top bar to load the grid.'}
        </p>
      </main>
    );
  }

  const { profile, payload, ledger = [] } = data;
  const freshness = assessFreshness(ledger, { now: new Date() });

  return (
    <main style={main}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
        <div>
          <h1 className="wa-page-title">{ENTITY_LABELS[entity]}</h1>
          <p className="wa-page-sub">
            {profile.label} · {period.start} to {period.end} · compared against {comparison.start} to{' '}
            {comparison.end} · all figures in {profile.currencyCode}
          </p>
        </div>

      </header>

      {payload?.truncated ? (
        <p style={{ ...muted, color: tokens.color.bad }}>
          This account has more than {formatInteger(ROW_CAP)} rows at this level, so the set below
          is truncated and its totals cover only what is shown. Narrow the period or the entity level
          for a complete read.
        </p>
      ) : null}

      <GridWorkspace
        entity={entity}
        rows={payload?.rows ?? []}
        currencyCode={profile.currencyCode}
        profileId={profile.id}
        period={period}
        comparisonPeriod={comparison}
        freshness={freshness}
        chip={data.crosscheck?.chip ?? null}
      />

      <p style={muted}>
        {/* The app's own accent, not the WP-06 literal: this link sits outside
            `.wa-embed`, so the legacy bridge in theme.css cannot retheme it and
            it rendered at 2.98:1 against the dark background. */}
        <a href={`/dashboard?profile=${profile.id}`} style={{ color: 'var(--wa-accent)' }}>
          ← Back to the dashboard
        </a>
      </p>
    </main>
  );
}

const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  gap: tokens.space(4),
  margin: '0 auto',
  maxWidth: '96rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: tokens.font.size.xl, margin: '0 0 0.25rem' };
const muted: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.base, margin: 0 };
