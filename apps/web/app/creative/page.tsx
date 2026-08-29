import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { readCreativePerformance } from '@wizard-ads/db';
import { gate } from '../../src/auth/guard';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { gateMessage } from '../../src/ui/gate-message';
import { Badge, EmptyState, PageHeader } from '../../src/ui/primitives';
import { OperatorContext } from '../../src/ui/operator-context';
import { page } from '../../src/ui/tokens';
import { periodFromParams, todayIso } from '../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../_lib/profiles';
import { CreativePerformanceExplorer } from './creative-performance';
import styles from './creative.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    profile?: string | string[];
    from?: string | string[];
    to?: string | string[];
  }>;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function CreativePerformancePage({ searchParams }: PageProps) {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Creative Performance" />
        <p className="wa-page-sub">{gateMessage(entry.state)}</p>
      </main>
    );
  }

  const query = await searchParams;
  const requested = await requestedProfileId(one(query.profile));
  const from = one(query.from);
  const to = one(query.to);
  const period = periodFromParams(
    {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    },
    todayIso(),
  );
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await listProfiles(entry.handle, orgId);
  const profile = selectProfile(profiles, requested);

  if (profile === null) {
    return (
      <main style={page}>
        <PageHeader
          title="Creative Performance"
          subtitle="Sponsored Brands Video · current observed Amazon Asset ID mappings"
        />
        <EmptyState
          title="No profiles yet"
          body="Connect Amazon Ads before loading creative performance."
          action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
        />
      </main>
    );
  }
  const canonical = canonicalProfilePath('/creative', query, profile.id);
  if (canonical !== null) redirect(canonical);

  const rows = readCreativePerformance(entry.handle, {
    orgId,
    profileId: profile.id,
    from: period.start,
    to: period.end,
  });

  return (
    <main style={{ ...page, maxWidth: '96rem' }}>
      <PageHeader
        title="Creative Performance"
        subtitle="Sponsored Brands Video performance by authoritative Amazon Asset ID"
        meta={
          <>
            <Badge tone="info">Sponsored Brands Video · v1</Badge>
            <Badge>Identity · Amazon Asset ID</Badge>
            <Suspense fallback={<Badge>Loading mapped assets…</Badge>}>
              <CreativeAssetCount rows={rows} />
            </Suspense>
          </>
        }
      />

      <OperatorContext
        account={profile.label}
        marketplace={profile.countryCode}
        currencyCode={profile.currencyCode}
        timezone={profile.timezone}
        path="/creative"
        period={period}
        today={todayIso()}
        preserved={{ profile: profile.id }}
      />

      <Suspense fallback={<CreativeResultsLoading />}>
        <CreativeResults
          rows={rows}
          currencyCode={profile.currencyCode}
          profileId={profile.id}
        />
      </Suspense>
    </main>
  );
}

type CreativeRows = Awaited<ReturnType<typeof readCreativePerformance>>;

async function CreativeAssetCount({ rows }: { rows: Promise<CreativeRows> }) {
  const resolved = await rows;
  return (
    <Badge>
      {resolved.length} mapped asset{resolved.length === 1 ? '' : 's'}
    </Badge>
  );
}

async function CreativeResults({
  rows,
  currencyCode,
  profileId,
}: {
  rows: Promise<CreativeRows>;
  currencyCode: string;
  profileId: string;
}) {
  const resolved = await rows;
  return resolved.length === 0 ? (
    <div className={styles.emptyWrap}>
      <EmptyState
        title="No mapped SB Video creatives yet"
        body={
          <>
            OpenSpell has no ad → creative → Amazon Asset ID performance mapping for this
            account and date range. Creative names and ad-group totals are not used as
            substitutes; mappings and metrics may arrive in separate sync cycles.
          </>
        }
        meta="Historical mapping validity remains unproven until an observed Asset-ID snapshot covers the report window."
        action={
          <a className="wa-btn wa-btn--sm" href={`/sync-status?profile=${profileId}`}>
            Check Sync status
          </a>
        }
        data-testid="creative-source-empty"
      />
    </div>
  ) : (
    <CreativePerformanceExplorer rows={resolved} currencyCode={currencyCode} />
  );
}

function CreativeResultsLoading() {
  return (
    <section aria-busy="true" aria-label="Creative performance loading">
      <div className={styles.loadingSummary}>
        {Array.from({ length: 4 }, (_, index) => <div key={index} />)}
      </div>
      <div className={styles.loadingTable} />
    </section>
  );
}
