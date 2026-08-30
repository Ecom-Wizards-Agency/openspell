/**
 * `/recommendations` — the review surface for engine proposals.
 *
 * The whole run is loaded and shipped in one payload, like the grid: QA-ing a
 * preview means sorting the set and scanning it, and server-side pagination
 * makes that workflow impossible (`tools/recon/02-data-grid.md` §6).
 *
 * The one thing this page does that the incumbent's does not: every proposal
 * arrives carrying the strategy / objective that produced it, resolved against
 * **the run's own doctrine snapshot** rather than today's document. That is the
 * constraint `docs/DECISIONS.md` puts on WP-07 so per-campaign strategy
 * assignment lands later as a data change.
 *
 * And the differentiator the brief names: the provenance panel. AdLabs publishes
 * the formula; we publish the numbers that went into this row.
 */
import type { CSSProperties } from 'react';
import { headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '@wizard-ads/db';
import {
  authenticationDestination,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { canonicalProfilePath } from '../../src/data/active-profile';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { toProposalView } from '../../src/recommendations/view';
import { selectRecommendationRun } from '../../src/recommendations/runs';
import { EmptyState } from '../../src/ui/primitives';
import { requestedProfileId } from '../_lib/profiles';
import { ReviewWorkspace } from './review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function RecommendationsPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    await requireOrgMembership(database, actor);
    const role = await requireOrgRole(database, actor);
    const query = await searchParams;

    const profiles = await listOrgProfiles(database, actor.orgId);
    const requested = await requestedProfileId(one(query['profile']));
    const profile = selectOrgProfile(profiles, requested);
    if (profile === null) {
      return (
        <main style={main}>
          <h1 style={heading}>Recommendations</h1>
          <EmptyState
            title="No profiles yet"
            body="This organisation has no advertising profiles, so there can be no recommendation run to review. Connect Amazon Ads to create the roster."
            action={
              <a className="wa-btn wa-btn--sm" href="/settings/connections">
                Connect Amazon Ads
              </a>
            }
          />
        </main>
      );
    }
    const canonical = canonicalProfilePath('/recommendations', query, profile.id);
    if (canonical !== null) redirect(canonical);

    const runs = await listRecommendationRuns(database, {
      orgId: actor.orgId,
      profileId: profile.id,
      limit: 20,
    });
    const requestedRun = one(query['run']);
    const runId = selectRecommendationRun(runs, requestedRun)?.id ?? null;
    const run = runId === null ? null : await getRecommendationRun(database, { orgId: actor.orgId, runId });

    const records =
      run === null || run.status !== 'succeeded'
        ? []
        : await listRecommendations(database, { orgId: actor.orgId, runId: run.id });
    const proposals = records.map((record) =>
      toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null }),
    );

    return (
      <main style={main} data-interactive="true">
        <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
            <h1 style={heading}>Recommendations</h1>
            {run === null || proposals.length === 0 ? null : (
              <a className="wa-btn wa-btn--primary wa-btn--sm" href="#recommendation-review">
                Open review
              </a>
            )}
          </div>
          <p style={muted}>
            {profile.label} · {profile.currencyCode} ·{' '}
            {run === null
              ? 'no run selected'
              : run.finishedAt === null
                ? `run ${run.status}`
                : `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} · ${run.windowStart ?? '?'} to ${run.windowEnd ?? '?'}`}
          </p>
          {run === null ? null : (
            <details className="wa-dashboard-context" style={{ marginTop: 0 }}>
              <summary>Run details</summary>
              <p>
                Engine {run.engineVersion ?? 'unversioned'} · status {run.status} · created{' '}
                {run.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC
                {run.groupSnapshot ? ` · group ${run.groupSnapshot.name} (${run.groupSnapshot.role})` : ' · legacy profile run'}
              </p>
            </details>
          )}
          {runs.length > 1 ? (
            <details className="wa-dashboard-context" style={{ marginTop: 0 }}>
              <summary>Choose run · {run?.groupSnapshot?.name ?? 'Legacy profile run'}</summary>
              <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }} aria-label="Runs">
                {runs.map((option) => (
                  <a
                    key={option.id}
                    href={`/recommendations?profile=${profile.id}&run=${option.id}`}
                    style={{ ...pill, fontWeight: option.id === run?.id ? 600 : 400 }}
                  >
                    {option.groupSnapshot?.name ?? 'Legacy profile'} · {option.createdAt.toISOString().slice(0, 10)} ·{' '}
                    {option.finishedAt === null ? option.status : option.proposalsCount}
                  </a>
                ))}
              </nav>
            </details>
          ) : null}
        </header>

        {run === null ? (
          <EmptyState
            title="No recommendations run yet"
            body="The weekly engine has not finished a run for this profile, so there is nothing to review yet. The optimizer shows the current facts and when the next run can start."
            action={
              <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
                Open optimizer
              </a>
            }
          />
        ) : run.finishedAt === null ? (
          <EmptyState
            title={run.status === 'running' ? 'Recommendations run in progress' : 'Recommendations run queued'}
            body={
              run.status === 'running'
                ? 'The worker is assembling facts, doctrine, pacing, and bid corridors now. Refresh shortly to see the preview.'
                : "The preview is in the worker queue. It will use the last complete seven-day window in this profile's timezone."
            }
          />
        ) : run.status !== 'succeeded' ? (
          <EmptyState
            title="Recommendations run failed"
            body="The worker recorded this run as failed. Queue a new preview after checking sync freshness and strategy settings."
          />
        ) : proposals.length === 0 ? (
          <EmptyState
            title="This run proposed nothing"
            body="The engine found no change worth proposing for this profile in this window. On a healthy account that can be the expected result."
            meta={
              <time dateTime={run.createdAt.toISOString()}>
                Run created {run.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC
              </time>
            }
            action={
              <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
                Open optimizer
              </a>
            }
          />
        ) : (
          <div id="recommendation-review">
            <ReviewWorkspace
              proposals={proposals}
              runId={run.id}
              profileId={profile.id}
              client={profile.label}
              counts={run.counts}
              role={role}
              hasStrategySnapshot={run.strategySnapshot !== null}
              runGroupName={run.groupSnapshot?.name}
            />
          </div>
        )}

        <p style={muted}>
          <a href={`/ngrams?profile=${profile.id}`}>N-gram explorer</a> ·{' '}
          <a href={`/grid?profile=${profile.id}`}>Grid</a>
        </p>
      </main>
    );
  } catch (error) {
    unstable_rethrow(error);
    // Nobody is signed in. A page is not an API: the answer to "who are you" is
    // the login screen, not a 200 that says "Authentication required" and
    // leaves the visitor to find `/login` themselves.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = error instanceof Error ? error.message : 'Recommendations are unavailable';
    return (
      <main style={main}>
        <h1 style={heading}>Recommendations</h1>
        <p role="alert">{message}</p>
      </main>
    );
  } finally {
    await database.close();
  }
}

const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--wa-font)',
  gap: '1.5rem',
  margin: '0 auto',
  maxWidth: '96rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: 0 };
const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 };
const pill: CSSProperties = {
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '999px',
  color: 'var(--wa-text)',
  fontSize: '0.8125rem',
  padding: '0.125rem 0.625rem',
  textDecoration: 'none',
};
