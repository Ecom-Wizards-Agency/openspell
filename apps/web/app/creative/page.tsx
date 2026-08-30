import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { readCreativePerformance, readLatestCreativeSyncSnapshot } from '@wizard-ads/db';
import { gate } from '../../src/auth/guard';
import { creativeLifecycle } from '../../src/creative/lifecycle';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { gateMessage } from '../../src/ui/gate-message';
import { Badge, EmptyState, PageHeader } from '../../src/ui/primitives';
import { OperatorContext } from '../../src/ui/operator-context';
import { page } from '../../src/ui/tokens';
import { periodFromParamsThroughToday, todayIsoInTimeZone } from '../_lib/periods';
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
    preset?: string | string[];
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
  const selectedPresetId = one(query.preset);
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

  const profileToday = todayIsoInTimeZone(profile.timezone);
  const period = periodFromParamsThroughToday(
    {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    },
    profileToday,
  );

  const rows = readCreativePerformance(entry.handle, {
    orgId,
    profileId: profile.id,
    from: period.start,
    to: period.end,
  });
  const snapshot = readLatestCreativeSyncSnapshot(entry.handle, { orgId, profileId: profile.id });

  return (
    <main style={{ ...page, maxWidth: '96rem' }}>
      <PageHeader
        title="Creative Performance"
        subtitle="Sponsored Brands Video performance by authoritative Amazon Asset ID"
        meta={
          <>
            <Badge tone="info">Sponsored Brands Video · v1</Badge>
            <Badge>Identity · Amazon Asset ID</Badge>
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
        today={profileToday}
        includeToday
        selectedPresetId={selectedPresetId}
        preserved={{ profile: profile.id, preset: selectedPresetId }}
      />

      <Suspense fallback={<CreativeLifecycleLoading />}>
        <CreativeLifecycleStatus
          snapshot={snapshot}
          timezone={profile.timezone}
          profileId={profile.id}
        />
      </Suspense>

      <Suspense fallback={<CreativeResultsLoading />}>
        <CreativeResults
          rows={rows}
          snapshot={snapshot}
          currencyCode={profile.currencyCode}
          profileId={profile.id}
        />
      </Suspense>
    </main>
  );
}

type CreativeRows = Awaited<ReturnType<typeof readCreativePerformance>>;
type CreativeSnapshot = Awaited<ReturnType<typeof readLatestCreativeSyncSnapshot>>;

async function CreativeLifecycleStatus({
  snapshot,
  timezone,
  profileId,
}: {
  snapshot: Promise<CreativeSnapshot>;
  timezone: string;
  profileId: string;
}) {
  const lifecycle = creativeLifecycle(await snapshot);
  return (
    <section
      aria-label="Creative synchronization evidence"
      className={styles.lifecycle}
      data-state={lifecycle.state}
      data-testid="creative-lifecycle"
    >
      <div className={styles.lifecycleCopy}>
        <span className={styles.lifecycleEyebrow}>
          <span aria-hidden="true" className={styles.lifecycleDot} />
          {lifecycle.eyebrow}
        </span>
        <strong>{lifecycle.title}</strong>
        <p>{lifecycle.body}</p>
      </div>
      {lifecycle.counts.length === 0 ? null : (
        <dl className={styles.lifecycleCounts}>
          {lifecycle.counts.map((count) => (
            <div key={count.label}>
              <dt>{count.label}</dt>
              <dd>{count.value.toLocaleString('en-US')}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className={styles.lifecycleMeta}>
        {lifecycle.observedAt === null ? null : (
          <span>
            Observed{' '}
            <time dateTime={lifecycle.observedAt}>{formatObserved(lifecycle.observedAt, timezone)}</time>
          </span>
        )}
        {lifecycle.coverage === null ? null : <span>Evidence date {lifecycle.coverage}</span>}
        <a href={`/sync-status?profile=${profileId}`}>Sync status →</a>
      </div>
    </section>
  );
}

async function CreativeResults({
  rows,
  snapshot,
  currencyCode,
  profileId,
}: {
  rows: Promise<CreativeRows>;
  snapshot: Promise<CreativeSnapshot>;
  currencyCode: string;
  profileId: string;
}) {
  const [resolved, latest] = await Promise.all([rows, snapshot]);
  const lifecycle = creativeLifecycle(latest);
  const hasPerformanceOutsideWindow = lifecycle.state === 'performance_ready';
  return resolved.length === 0 ? (
    <div className={styles.emptyWrap}>
      <EmptyState
        title={hasPerformanceOutsideWindow ? 'No creative performance in this date range' : lifecycle.title}
        body={
          hasPerformanceOutsideWindow
            ? 'The latest sync promoted attributable facts, but none fall inside the selected reporting window.'
            : lifecycle.body
        }
        meta="Creative names and ad-group totals are never substituted for an observed ad → creative → Amazon Asset ID mapping."
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

function CreativeLifecycleLoading() {
  return <div aria-hidden="true" className={styles.lifecycleLoading} />;
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

function formatObserved(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}
