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
import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '@wizard-ads/db';
import {
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { toProposalView } from '../../src/recommendations/view';
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
    const profile = selectOrgProfile(profiles, one(query['profile']));
    if (profile === null) {
      return (
        <main style={main}>
          <h1 style={heading}>Recommendations</h1>
          <p style={muted}>This organisation has no advertising profiles yet.</p>
        </main>
      );
    }

    const runs = await listRecommendationRuns(database, {
      orgId: actor.orgId,
      profileId: profile.id,
      limit: 20,
    });
    const requestedRun = one(query['run']);
    const runId = requestedRun ?? runs[0]?.id ?? null;
    const run = runId === null ? null : await getRecommendationRun(database, { orgId: actor.orgId, runId });

    const records =
      run === null
        ? []
        : await listRecommendations(database, { orgId: actor.orgId, runId: run.id });
    const proposals = records.map((record) =>
      toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null }),
    );

    return (
      <main style={main} data-interactive="true">
        <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h1 style={heading}>Recommendations</h1>
          <p style={muted}>
            {profile.label} · {profile.currencyCode} ·{' '}
            {run === null
              ? 'no runs yet'
              : `run ${run.engineVersion ?? 'unversioned'} over ${run.windowStart ?? '?'} to ${run.windowEnd ?? '?'}`}
          </p>
          {profiles.length > 1 ? (
            <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }} aria-label="Profiles">
              {profiles.map((option) => (
                <a
                  key={option.id}
                  href={`/recommendations?profile=${option.id}`}
                  style={{
                    ...pill,
                    fontWeight: option.id === profile.id ? 600 : 400,
                  }}
                >
                  {option.label}
                </a>
              ))}
            </nav>
          ) : null}
          {runs.length > 1 ? (
            <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }} aria-label="Runs">
              {runs.map((option) => (
                <a
                  key={option.id}
                  href={`/recommendations?profile=${profile.id}&run=${option.id}`}
                  style={{ ...pill, fontWeight: option.id === run?.id ? 600 : 400 }}
                >
                  {option.createdAt.toISOString().slice(0, 10)} · {option.proposalsCount}
                </a>
              ))}
            </nav>
          ) : null}
        </header>

        {run === null ? (
          <p style={muted}>
            No recommendation run has finished for this profile. The weekly engine writes one; until
            then there is nothing to review, which is not the same as nothing to do.
          </p>
        ) : (
          <ReviewWorkspace
            proposals={proposals}
            runId={run.id}
            profileId={profile.id}
            client={profile.label}
            counts={run.counts}
            role={role}
            hasStrategySnapshot={run.strategySnapshot !== null}
          />
        )}

        <p style={muted}>
          <a href={`/ngrams?profile=${profile.id}`}>N-gram explorer</a> ·{' '}
          <a href={`/grid?profile=${profile.id}`}>Grid</a>
        </p>
      </main>
    );
  } catch (error) {
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
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  gap: '1.5rem',
  margin: '0 auto',
  maxWidth: '96rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: 0 };
const muted: CSSProperties = { color: '#6b7280', fontSize: '0.875rem', margin: 0 };
const pill: CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: '999px',
  color: '#111827',
  fontSize: '0.8125rem',
  padding: '0.125rem 0.625rem',
  textDecoration: 'none',
};
