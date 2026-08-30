/**
 * `/grid` — the entity grid.
 *
 * The browser loads the **whole** result set for the selected entity level and
 * period from the authenticated `/api/grid/rows` boundary. Keeping every row
 * client-side is the product decision the recon argues for at length
 * (`02-data-grid.md` §6): QA-ing an optimization means sorting four thousand
 * rows by spend, filtering to one change reason and scanning. The separate
 * request keeps those rows out of the initial RSC document without introducing
 * server pagination or a second Grid model.
 *
 * Database and raw-response byte caps bound the result. Past either boundary
 * the page says the set is truncated rather than quietly showing a prefix,
 * because a total computed over an unmarked prefix is the kind of wrong number
 * that gets quoted on a client call.
 *
 * Entry goes through `gate()`, the same guard `/settings` uses: anonymous
 * visitors are sent to `/login`, and both the roster and the rows are scoped by
 * the org the gate resolved rather than by a profile id anybody could paste.
 */
import { Suspense, type CSSProperties } from 'react';
import { redirect } from 'next/navigation';
import {
  ENTITY_LABELS,
  ENTITY_LEVELS,
  assessFreshness,
  tokens,
} from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import type { DbHandle } from '@wizard-ads/db';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { gate } from '../../src/auth/guard';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { gateMessage } from '../../src/ui/gate-message';
import { loadReportLedger } from '../_lib/dashboard-data';
import { withExistingDatabase } from '../_lib/db';
import { periodFromParams, precedingPeriod, todayIso } from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { OperatorContext } from '../../src/ui/operator-context';
import { GridWorkspace } from './grid-client';
import { CrosscheckChip } from '../crosscheck/panel';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    profile?: string;
    entity?: string;
    campaign?: string;
    from?: string;
    to?: string;
  }>;
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
  const profileId = await requestedProfileId(params.profile);
  const entity = parseEntity(params.entity);
  const period = periodFromParams(params, todayIso());
  const comparison = precedingPeriod(period);

  const data = await withExistingDatabase(entry.handle, async (handle) => {
    const profiles = await listProfiles(handle, orgId);
    const profile = selectProfile(profiles, profileId);
    if (profile === null) return { profiles, profile: null };
    const canonical = canonicalProfilePath('/grid', { ...params }, profile.id);
    if (canonical !== null) redirect(canonical);

    const ledger = await loadReportLedger(handle, orgId, profile.id);

    return { profiles, profile, ledger };
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

  const { profile, ledger = [] } = data;
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

      <OperatorContext
        account={profile.label}
        marketplace={profile.countryCode}
        currencyCode={profile.currencyCode}
        timezone={profile.timezone}
        path="/grid"
        period={period}
        today={todayIso()}
        preserved={{
          profile: profile.id,
          entity,
          ...(params.campaign === undefined ? {} : { campaign: params.campaign }),
        }}
      />

      <GridWorkspace
        key={`${profile.id}:${entity}:${period.start}:${period.end}:${params.campaign ?? ''}`}
        entity={entity}
        currencyCode={profile.currencyCode}
        profileId={profile.id}
        period={period}
        comparisonPeriod={comparison}
        freshness={freshness}
        crosscheck={
          <Suspense fallback={<span style={crosscheckPending}>Crosscheck loading…</span>}>
            <GridCrosscheck handle={entry.handle} profileId={profile.id} />
          </Suspense>
        }
        campaignId={entity === 'campaigns' ? params.campaign ?? null : null}
      />

      <p style={muted}>
        {/* The accent token rather than a hex literal: an inline colour does not
            follow the theme, and the literal this replaced rendered at 2.98:1
            against the dark background. */}
        <a href={`/dashboard?profile=${profile.id}`} style={{ color: 'var(--wa-accent)' }}>
          ← Back to the dashboard
        </a>
      </p>
    </main>
  );
}

/**
 * Crosscheck evidence is useful context, not a prerequisite for operating the
 * grid. Keep its independent database read outside the critical row-delivery
 * path so a slow or unavailable comparison source cannot delay filtering,
 * grouping, or export.
 */
async function GridCrosscheck({
  handle,
  profileId,
}: {
  handle: DbHandle;
  profileId: string;
}) {
  const model = await loadCrosscheckPanel(handle, { profileId }).catch(() => null);
  return model === null ? null : <CrosscheckChip chip={model.chip} />;
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
const crosscheckPending: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.sm,
};
