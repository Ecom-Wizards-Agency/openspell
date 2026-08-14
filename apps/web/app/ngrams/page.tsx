/**
 * `/ngrams` — the n-gram explorer.
 *
 * A search-term report is thousands of rows of which most have one or two
 * clicks, so no single row carries evidence; the signal lives in the words
 * those rows share. This page loads the profile's search terms for a period
 * once and hands them to the client, which aggregates them in the engine — so
 * the uni/bi/tri toggle, the scope selector and the click floor are instant and
 * cost no round trip.
 *
 * Loading the whole set is the same decision the grid makes and for the same
 * reason. Past the cap the page says the set is truncated rather than showing
 * an unmarked prefix whose totals nobody can trust.
 */
import type { CSSProperties } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  isUnauthenticated,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { SEARCH_TERM_CAP, loadScopes, loadSearchTermRows } from '../../src/ngrams/data';
import { periodFromParams, todayIso } from '../_lib/periods';
import { NgramExplorer } from './explorer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function NgramsPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    await requireOrgMembership(database, actor);
    const query = await searchParams;

    const profiles = await listOrgProfiles(database, actor.orgId);
    const profile = selectOrgProfile(profiles, one(query['profile']));
    if (profile === null) {
      return (
        <main style={main}>
          <h1 style={heading}>N-gram explorer</h1>
          <p style={muted}>This organisation has no advertising profiles yet.</p>
        </main>
      );
    }

    const from = one(query['from']);
    const to = one(query['to']);
    const period = periodFromParams(
      { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
      todayIso(),
    );
    const [payload, scopes] = await Promise.all([
      loadSearchTermRows(database, {
        orgId: actor.orgId,
        profileId: profile.id,
        period,
      }),
      loadScopes(database, { orgId: actor.orgId, profileId: profile.id }),
    ]);

    return (
      <main style={main} data-interactive="true">
        <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h1 style={heading}>N-gram explorer</h1>
          <p style={muted}>
            {profile.label} · {period.start} to {period.end} · {payload.rows.length} search terms ·
            all figures in {profile.currencyCode}
          </p>
          <p style={muted}>
            A gram is counted once per search term, however many times it occurs in it. Spend is
            attributed to every gram a term contains, so gram totals overlap and do not sum to
            account spend — the search-terms column is what keeps that visible.
          </p>
        </header>

        {payload.truncated ? (
          <p style={{ ...muted, color: 'var(--wa-bad-text)' }}>
            More than {SEARCH_TERM_CAP} search terms in this period, so the set below is truncated
            and its totals cover only what is shown. Narrow the period for a complete read.
          </p>
        ) : null}

        <div className="wa-embed">
          <NgramExplorer
            rows={payload.rows}
          scopes={scopes}
          profileId={profile.id}
          currencyCode={profile.currencyCode}
            period={period}
          />
        </div>

        <p style={muted}>
          <a href={`/recommendations?profile=${profile.id}`}>Recommendations</a> ·{' '}
          <a href={`/grid?profile=${profile.id}&entity=search_terms`}>Search-term grid</a>
        </p>
      </main>
    );
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen rather
    // than a 200 that reads "Authentication required".
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'The explorer is unavailable';
    return (
      <main style={main}>
        <h1 style={heading}>N-gram explorer</h1>
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
const heading: CSSProperties = { fontSize: 'var(--wa-fs-xl)', fontWeight: 640, letterSpacing: '-0.02em', margin: 0 };
const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 };
