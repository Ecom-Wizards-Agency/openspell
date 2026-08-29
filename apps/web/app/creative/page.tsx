import { readCreativePerformance } from '@wizard-ads/db';
import { gate } from '../../src/auth/guard';
import { gateMessage } from '../../src/ui/gate-message';
import { Badge, EmptyState, PageHeader } from '../../src/ui/primitives';
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
          subtitle="Sponsored Brands Video · authoritative Amazon Asset ID reporting"
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
        subtitle={`${profile.label} · ${period.start} to ${period.end} · ${profile.currencyCode}`}
        meta={
          <>
            <Badge tone="info">Sponsored Brands Video · v1</Badge>
            <Badge>Identity · Amazon Asset ID</Badge>
            <Badge>{rows.length} attribution row{rows.length === 1 ? '' : 's'}</Badge>
          </>
        }
      />

      <form method="get" className={styles.scopeBar} aria-label="Creative performance scope">
        <label>
          <span>Profile</span>
          <select name="profile" defaultValue={profile.id} className="wa-select">
            {profiles.map((option) => (
              <option key={option.id} value={option.id}>{option.label} · {option.countryCode}</option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input name="from" type="date" defaultValue={period.start} className="wa-input" />
        </label>
        <label>
          <span>To</span>
          <input name="to" type="date" defaultValue={period.end} className="wa-input" />
        </label>
        <button className="wa-btn wa-btn--primary" type="submit">Apply range</button>
        <a className="wa-btn wa-btn--ghost" href={`/creative?profile=${profile.id}`}>Last 30 days</a>
      </form>

      {rows.length === 0 ? (
        <div className={styles.emptyWrap}>
          <EmptyState
            title="No SB Video data in this window"
            body={
              <>
                The sync has not loaded ad-level creative facts for these dates. Widen the range or
                check Sync status. Ad-group totals are never assigned to a single creative.
              </>
            }
            meta={`${period.start} to ${period.end} · ${profile.label}`}
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
