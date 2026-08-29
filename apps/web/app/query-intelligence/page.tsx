import type { CSSProperties } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { QueryCategory } from '@wizard-ads/shared';
import {
  isUnauthenticated,
  openWebDatabase,
  requestActor,
} from '../../src/server/request-context';
import { requireOrgRole } from '../../src/server/org-role';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import {
  listQueryIntelligenceScopes,
  loadQueryIntelligenceSource,
} from '../../src/query-intelligence/data';
import { buildQueryIntelligenceModel } from '../../src/query-intelligence/model';
import {
  QUERY_CATEGORY_OPTIONS,
  QueryIntelligenceWorkspace,
} from './workspace';
import styles from './query-intelligence.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function selectedScope(
  scopes: Awaited<ReturnType<typeof listQueryIntelligenceScopes>>,
  value: string | undefined,
) {
  const [marketplaceId, weekStart] = value?.split('|') ?? [];
  return (
    scopes.find(
      (scope) => scope.marketplaceId === marketplaceId && scope.weekStart === weekStart,
    ) ?? scopes[0] ?? null
  );
}

export default async function QueryIntelligencePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    const role = await requireOrgRole(database, actor);
    const query = await searchParams;
    const profiles = await listOrgProfiles(database, actor.orgId);
    const profile = selectOrgProfile(profiles, one(query['profile']));
    if (profile === null) {
      return (
        <main className="wa-stack">
          <header className="wa-page-head">
            <div>
              <h1 className="wa-page-title">Query Intelligence</h1>
              <p className="wa-page-sub">This organisation has no advertising profiles yet.</p>
            </div>
          </header>
        </main>
      );
    }

    const scopes = await listQueryIntelligenceScopes(database, {
      orgId: actor.orgId,
      profileId: profile.id,
    });
    const scope = selectedScope(scopes, one(query['scope']));
    const rawCategory = one(query['category']);
    const categoryResult = QueryCategory.safeParse(rawCategory);
    const category = categoryResult.success ? categoryResult.data : null;
    const search = one(query['q'])?.slice(0, 160) ?? '';

    if (scope === null) {
      return (
        <main className="wa-stack">
          <header className="wa-page-head">
            <div>
              <h1 className="wa-page-title">Query Intelligence</h1>
              <p className="wa-page-sub">
                {profile.label} · SP-API Brand Analytics Search Query Performance
              </p>
            </div>
          </header>
          <div className="wa-empty">
            <p className="wa-empty__title">No authoritative weekly SQP data</p>
            <p className="wa-empty__body">
              No marketplace/week has a complete Query Intelligence contract yet. The worker must
              promote a Sunday–Saturday SP-API Brand Analytics report before this page can compare
              search demand, shares, and PPC attribution.
            </p>
            <p className="wa-empty__meta">No report was requested and no Amazon change was made.</p>
          </div>
        </main>
      );
    }

    const source = await loadQueryIntelligenceSource(database, {
      orgId: actor.orgId,
      profileId: profile.id,
      marketplaceId: scope.marketplaceId,
      weekStart: scope.weekStart,
      weekEnd: scope.weekEnd,
    });
    const model = buildQueryIntelligenceModel(source);

    return (
      <main className="wa-stack" data-interactive="true">
        <header className="wa-page-head">
          <div>
            <h1 className="wa-page-title">Query Intelligence</h1>
            <p className="wa-page-sub">
              {profile.label} · {scope.marketplaceId} · {scope.weekStart} to {scope.weekEnd}
            </p>
          </div>
          <span className="wa-badge wa-badge--info">Read-only operator workspace</span>
        </header>

        <form className="wa-toolbar" method="get" aria-label="Query intelligence filters">
          <input type="hidden" name="profile" value={profile.id} />
          <label className="wa-field" style={filterControl}>
            <span className="wa-label">Marketplace and week</span>
            <select
              className="wa-select wa-select--sm"
              name="scope"
              defaultValue={`${scope.marketplaceId}|${scope.weekStart}`}
            >
              {scopes.map((option) => (
                <option
                  key={`${option.marketplaceId}:${option.weekStart}`}
                  value={`${option.marketplaceId}|${option.weekStart}`}
                >
                  {option.marketplaceId} · {option.weekStart} to {option.weekEnd}
                </option>
              ))}
            </select>
          </label>
          <label className="wa-field" style={filterControl}>
            <span className="wa-label">Intent</span>
            <select className="wa-select wa-select--sm" name="category" defaultValue={category ?? ''}>
              <option value="">All six categories</option>
              {QUERY_CATEGORY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="wa-field" style={{ ...filterControl, flex: '1 1 16rem' }}>
            <span className="wa-label">Find query, ASIN, campaign, or ad group</span>
            <input className="wa-input wa-input--sm" type="search" name="q" defaultValue={search} />
          </label>
          <button className="wa-btn wa-btn--sm" type="submit">Apply</button>
          {category !== null || search.length > 0 ? (
            <a
              className="wa-btn wa-btn--ghost wa-btn--sm"
              href={`/query-intelligence?${new URLSearchParams({
                profile: profile.id,
                scope: `${scope.marketplaceId}|${scope.weekStart}`,
              })}`}
            >
              Clear
            </a>
          ) : null}
          <span className={styles.toolbarMeta}>
            {scope.factRows} query/ASIN rows · loaded{' '}
            {new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
              new Date(scope.loadedAt),
            )}
          </span>
        </form>

        <QueryIntelligenceWorkspace
          model={model}
          currencyCode={profile.currencyCode}
          selectedCategory={category}
          search={search}
          profileId={profile.id}
          marketplaceId={scope.marketplaceId}
          role={role}
        />
      </main>
    );
  } catch (error) {
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'Query Intelligence is unavailable';
    return (
      <main className="wa-stack">
        <header className="wa-page-head">
          <div>
            <h1 className="wa-page-title">Query Intelligence</h1>
            <p className="wa-page-sub">Weekly SQP and PPC evidence could not be loaded.</p>
          </div>
        </header>
        <p className="wa-banner wa-banner--bad" role="alert">{message}</p>
      </main>
    );
  } finally {
    await database.close();
  }
}

const filterControl: CSSProperties = { minWidth: '10rem' };
