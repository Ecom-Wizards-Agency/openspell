import { readCreativePerformance } from '@wizard-ads/db';
import { gate } from '../../src/auth/guard';
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

  const rows = await readCreativePerformance(entry.handle, {
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
            <Badge>{rows.length} mapped asset{rows.length === 1 ? '' : 's'}</Badge>
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

      {rows.length === 0 ? (
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
            action={<a className="wa-btn wa-btn--sm" href={`/sync-status?profile=${profile.id}`}>Check Sync status</a>}
            data-testid="creative-source-empty"
          />
        </div>
      ) : (
        <CreativePerformanceExplorer rows={rows} currencyCode={profile.currencyCode} />
      )}
    </main>
  );
}
