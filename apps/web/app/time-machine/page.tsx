/**
 * `/time-machine` — the account's change history, read only.
 *
 * AdLabs' change log, over data we already keep: `entity_changes` (what a sync
 * noticed drift on) unioned with the operator's own export batches. One
 * reverse-chronological timeline per profile, grouped by day the way the
 * incumbent does, filterable by entity type, field, source and date range.
 *
 * Fully server-rendered: it proposes nothing and writes nothing, so the filters
 * are a plain GET form and every control is a link or a query parameter. No
 * server action, no client island — a page that only reads has no state to hold.
 */
import type { CSSProperties } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  getReversionBatchPreview,
  listReversionBatches,
  listTimeline,
  listTimelineFacets,
} from '@wizard-ads/db';
import type { ChangeSource, TimelineEntry } from '@wizard-ads/db';
import {
  isUnauthenticated,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../src/server/request-context';
import { listOrgProfiles, selectOrgProfile } from '../../src/recommendations/data';
import { requireOrgRole } from '../../src/server/org-role';
import { can } from '../../src/auth/roles';
import { ReversionPanel } from './reversion-panel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const TIMELINE_PAGE_SIZE = 50;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** entity_change / apply entity types → the grid level that shows them. */
const GRID_LEVEL: Record<string, string> = {
  campaign: 'campaigns',
  ad_group: 'ad_groups',
  keyword: 'targets',
  target: 'targets',
  placement: 'placements',
};

const ENTITY_LABEL: Record<string, string> = {
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  ad_group: 'Ad group',
  product_ad: 'Product ad',
  keyword: 'Keyword',
  target: 'Target',
  negative: 'Negative',
  placement: 'Placement',
};

function isDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function timelineCursor(query: Record<string, string | string[] | undefined>): {
  observedAt: string;
  id: string;
} | null {
  const observedAt = one(query['before_at']);
  const id = one(query['before_id']);
  if (observedAt === undefined || id === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt)) return null;
  if (observedAt.startsWith('0000-')) return null;
  if (!/^(?:change|apply):(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(id)) return null;
  const parsed = new Date(observedAt);
  const canonical = observedAt.includes('.') ? observedAt : observedAt.replace('Z', '.000Z');
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical ? null : { observedAt, id };
}

function formatValue(value: TimelineEntry['oldValue']): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});
const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface DayGroup {
  key: string;
  label: string;
  entries: TimelineEntry[];
}

function groupByDay(entries: readonly TimelineEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.observedAt);
    if (current === null || current.key !== key) {
      current = { key, label: DAY_FORMAT.format(entry.observedAt), entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export default async function TimeMachinePage({ searchParams }: { searchParams: SearchParams }) {
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
          <h1 style={heading}>Time Machine</h1>
          <p style={muted}>This organisation has no advertising profiles yet.</p>
        </main>
      );
    }

    const facets = await listTimelineFacets(database, {
      orgId: actor.orgId,
      profileId: profile.id,
    });

    const rawEntityType = one(query['type']);
    const entityType = rawEntityType && facets.entityTypes.includes(rawEntityType) ? rawEntityType : null;
    const rawField = one(query['field']);
    const field = rawField && facets.fields.includes(rawField) ? rawField : null;
    const rawSource = one(query['source']);
    const source: ChangeSource | null = rawSource === 'sync' || rawSource === 'apply' ? rawSource : null;
    const requestedFrom = one(query['from']);
    const requestedTo = one(query['to']);
    const from = isDate(requestedFrom) ? requestedFrom : null;
    const toParam = isDate(requestedTo) ? requestedTo : null;
    const cursor = timelineCursor(query);
    // The `to` bound is a whole day: extend an end date to the end of that day.
    const toBound = toParam === null ? null : `${toParam}T23:59:59.999Z`;

    const timelineWindow = await listTimeline(database, {
      orgId: actor.orgId,
      profileId: profile.id,
      entityTypes: entityType ? [entityType] : null,
      field,
      source,
      from: from ?? null,
      to: toBound,
      limit: TIMELINE_PAGE_SIZE + 1,
      before: cursor,
    });
    const hasOlder = timelineWindow.length > TIMELINE_PAGE_SIZE;
    const entries = timelineWindow.slice(0, TIMELINE_PAGE_SIZE);
    const reversionBatches = await listReversionBatches(database, {
      orgId: actor.orgId,
      profileId: profile.id,
    });
    const requestedBatch = one(query['batch']);
    const selectedBatch =
      requestedBatch === undefined
        ? null
        : reversionBatches.find((batch) => batch.batchId === requestedBatch) ?? null;
    const reversionPreview =
      selectedBatch === null
        ? null
        : await getReversionBatchPreview(database, {
            orgId: actor.orgId,
            batchId: selectedBatch.batchId,
          });
    const days = groupByDay(entries);
    const hasAnyHistory = facets.entityTypes.length > 0 || facets.fields.length > 0;
    const filtersActive = entityType !== null || field !== null || source !== null || from !== null || toParam !== null;

    const base = (extra: Record<string, string>): string => {
      const params = new URLSearchParams({ profile: profile.id, ...extra });
      return `/time-machine?${params.toString()}`;
    };
    const pageHref = (before: TimelineEntry | null): string => {
      const params = new URLSearchParams({ profile: profile.id });
      if (entityType !== null) params.set('type', entityType);
      if (field !== null) params.set('field', field);
      if (source !== null) params.set('source', source);
      if (from !== null) params.set('from', from);
      if (toParam !== null) params.set('to', toParam);
      if (selectedBatch !== null) params.set('batch', selectedBatch.batchId);
      if (before !== null) {
        params.set('before_at', before.observedAt.toISOString());
        params.set('before_id', before.id);
      }
      return `/time-machine?${params.toString()}`;
    };

    return (
      <main style={main} data-interactive="true">
        <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <h1 style={heading}>Time Machine</h1>
          <p style={muted}>
            {profile.label}{' · '}{profile.countryCode}{' · '}exported batches, synchronized evidence, and
            external account changes. Reviewing this history does not change Amazon.
          </p>
          {profiles.length > 1 ? (
            <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }} aria-label="Profiles">
              {profiles.map((option) => (
                <a
                  key={option.id}
                  href={`/time-machine?profile=${option.id}`}
                  style={{ ...pill, fontWeight: option.id === profile.id ? 600 : 400 }}
                >
                  {option.label}
                </a>
              ))}
            </nav>
          ) : null}
        </header>

        {reversionBatches.length === 0 ? null : (
          <section className="wa-tm-batches" aria-labelledby="export-batches-title">
            <header className="wa-tm-section-head">
              <div>
                <span className="wa-label">Batch history</span>
                <h2 id="export-batches-title">Exports and reversions</h2>
              </div>
              <span>{reversionBatches.length} recent batch{reversionBatches.length === 1 ? '' : 'es'}</span>
            </header>
            <nav className="wa-tm-batch-list" aria-label="Export batches">
              {reversionBatches.map((batch) => (
                <a
                  key={batch.batchId}
                  href={`/time-machine?${new URLSearchParams({ profile: profile.id, batch: batch.batchId })}`}
                  className={batch.batchId === selectedBatch?.batchId ? 'is-selected' : undefined}
                  data-testid="time-machine-batch"
                >
                  <span>
                    <strong>{batch.tag}</strong>
                    <small>{batch.optGroup} · {batch.lever}</small>
                  </span>
                  <span>
                    <strong>{batch.reversibleRows}</strong>
                    <small>{batch.lifecycleStatus.replaceAll('_', ' ')}</small>
                  </span>
                </a>
              ))}
            </nav>
          </section>
        )}

        {reversionPreview === null ? null : (
          <ReversionPanel preview={reversionPreview} canExport={can(role, 'exportBatches')} />
        )}

        {reversionBatches.length > 0 && selectedBatch === null ? (
          <p className="wa-page-sub" data-testid="time-machine-batch-prompt">
            Select a batch to inspect synchronized evidence and preview an exact reversion.
          </p>
        ) : null}

        {hasAnyHistory ? (
          <form method="get" style={filters} aria-label="Filter changes" data-testid="timeline-filters">
            <input type="hidden" name="profile" value={profile.id} />
            <label style={fieldLabel}>
              Entity type
              <select name="type" defaultValue={entityType ?? ''} style={control} data-testid="filter-type">
                <option value="">All types</option>
                {facets.entityTypes.map((value) => (
                  <option key={value} value={value}>
                    {ENTITY_LABEL[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabel}>
              Field
              <select name="field" defaultValue={field ?? ''} style={control} data-testid="filter-field">
                <option value="">All fields</option>
                {facets.fields.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabel}>
              Source
              <select name="source" defaultValue={source ?? ''} style={control} data-testid="filter-source">
                <option value="">Any source</option>
                <option value="sync">Sync detected</option>
                <option value="apply">Operator export</option>
              </select>
            </label>
            <label style={fieldLabel}>
              From
              <input type="date" name="from" defaultValue={from ?? ''} style={control} data-testid="filter-from" />
            </label>
            <label style={fieldLabel}>
              To
              <input type="date" name="to" defaultValue={toParam ?? ''} style={control} data-testid="filter-to" />
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
              <button type="submit" style={submitButton} data-testid="filter-apply">
                Apply
              </button>
              {filtersActive ? (
                <a href={base({})} style={{ ...pill, alignSelf: 'center' }} data-testid="filter-clear">
                  Clear
                </a>
              ) : null}
            </div>
          </form>
        ) : null}

        {cursor !== null ? (
          <nav style={pagination} aria-label="Change history position" data-testid="timeline-pagination">
            <a href={pageHref(null)} style={pill} data-testid="timeline-newer">
              ← Newest changes
            </a>
          </nav>
        ) : null}

        {!hasAnyHistory ? (
          <p style={empty} data-testid="timeline-empty" role="status">
            No changes recorded yet — they appear as sync detects them or you apply them.
          </p>
        ) : entries.length === 0 && cursor !== null ? (
          <p style={empty} data-testid="timeline-empty-cursor" role="status">
            No older changes remain. Return to the newest changes to continue reviewing history.
          </p>
        ) : entries.length === 0 ? (
          <p style={empty} data-testid="timeline-empty-filtered" role="status">
            No changes match these filters.{' '}
            <a href={base({})}>Clear filters</a> to see the full history.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }} data-testid="timeline">
            {days.map((day) => (
              <section key={day.key} aria-label={day.label}>
                <h2 style={dayHeading} data-testid="timeline-day">
                  {day.label}
                  <span style={dayCount}>{day.entries.length}</span>
                </h2>
                <ul style={entryList}>
                  {day.entries.map((entry) => {
                    const level = GRID_LEVEL[entry.entityType];
                    return (
                      <li key={entry.id} style={entryRow} data-testid="timeline-entry" data-source={entry.source}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'baseline' }}>
                          <span
                            style={entry.source === 'apply' ? applyBadge : syncBadge}
                            data-testid="entry-source"
                          >
                            {entry.source === 'sync'
                              ? 'Sync'
                              : entry.batch?.sourceBatchId != null
                                ? 'Reversion export'
                                : entry.batch?.status === 'applied'
                                  ? 'Applied externally'
                                  : entry.batch?.status === 'reverted'
                                    ? 'Verified reverted'
                                    : entry.batch?.status === 'abandoned'
                                      ? 'Abandoned'
                                      : 'Exported'}
                          </span>
                          <span style={{ fontWeight: 600 }}>{ENTITY_LABEL[entry.entityType] ?? entry.entityType}</span>
                          <span style={{ color: 'var(--wa-text)' }}>
                            {entry.entityName ?? entry.amazonId}
                          </span>
                          <span style={muted}>· {entry.field}</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'baseline' }}>
                          <code style={oldChip}>{formatValue(entry.oldValue)}</code>
                          <span aria-hidden="true" style={muted}>→</span>
                          <code style={newChip}>{formatValue(entry.newValue)}</code>
                          <span style={timeText}>{TIME_FORMAT.format(entry.observedAt)} UTC</span>
                          {entry.batch !== null && entry.batch.note ? (
                            <span style={muted} title={entry.batch.tag}>
                              · {entry.batch.note}
                            </span>
                          ) : null}
                          {level ? (
                            <a
                              href={`/grid?profile=${profile.id}&entity=${level}`}
                              style={gotoLink}
                              data-testid="entry-goto"
                            >
                              View in grid →
                            </a>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {hasOlder ? (
              <nav style={pagination} aria-label="Change history pages" data-testid="timeline-pagination">
                <span />
                <a href={pageHref(entries.at(-1) ?? null)} style={pill} data-testid="timeline-older">
                  Older changes →
                </a>
              </nav>
            ) : null}
          </div>
        )}
      </main>
    );
  } catch (error) {
    if (isUnauthenticated(error)) redirect('/login');
    const message = error instanceof Error ? error.message : 'The change history is unavailable';
    return (
      <main style={main}>
        <h1 style={heading}>Time Machine</h1>
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
  maxWidth: '72rem',
  padding: '2rem 1.5rem',
};

const pagination: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  justifyContent: 'space-between',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: 0 };
const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 };
const empty: CSSProperties = {
  ...muted,
  border: '1px dashed var(--wa-border-strong)',
  borderRadius: '0.5rem',
  padding: '1.5rem',
};
const pill: CSSProperties = {
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '999px',
  color: 'var(--wa-text)',
  fontSize: '0.8125rem',
  padding: '0.125rem 0.625rem',
  textDecoration: 'none',
};
const filters: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
  alignItems: 'flex-end',
  border: '1px solid var(--wa-border)',
  borderRadius: '0.5rem',
  padding: '0.875rem 1rem',
};
const fieldLabel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.75rem',
  color: 'var(--wa-text-muted)',
};
const control: CSSProperties = {
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '0.375rem',
  background: 'var(--wa-surface)',
  color: 'var(--wa-text)',
  fontSize: '0.8125rem',
  padding: '0.3125rem 0.5rem',
};
const submitButton: CSSProperties = {
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '0.375rem',
  background: 'var(--wa-surface)',
  color: 'var(--wa-text)',
  fontSize: '0.8125rem',
  fontWeight: 600,
  padding: '0.375rem 0.875rem',
  cursor: 'pointer',
};
const dayHeading: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.9375rem',
  margin: '0 0 0.625rem',
  paddingBottom: '0.375rem',
  borderBottom: '1px solid var(--wa-border)',
};
const dayCount: CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 400,
  color: 'var(--wa-text-muted)',
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '999px',
  padding: '0 0.4375rem',
};
const entryList: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};
const entryRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  border: '1px solid var(--wa-border)',
  borderRadius: '0.5rem',
  padding: '0.625rem 0.875rem',
  fontSize: '0.875rem',
};
const badgeBase: CSSProperties = {
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  borderRadius: '0.25rem',
  padding: '0.0625rem 0.375rem',
};
const syncBadge: CSSProperties = {
  ...badgeBase,
  background: 'var(--wa-info-bg)',
  color: 'var(--wa-info-text)',
};
const applyBadge: CSSProperties = {
  ...badgeBase,
  background: 'var(--wa-good-bg)',
  color: 'var(--wa-good-text)',
};
const chipBase: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.8125rem',
  borderRadius: '0.25rem',
  padding: '0.0625rem 0.375rem',
  border: '1px solid var(--wa-border)',
};
const oldChip: CSSProperties = { ...chipBase, color: 'var(--wa-text-muted)' };
const newChip: CSSProperties = { ...chipBase, color: 'var(--wa-text)', fontWeight: 600 };
const timeText: CSSProperties = { ...muted, fontVariantNumeric: 'tabular-nums' };
const gotoLink: CSSProperties = {
  color: 'var(--wa-accent-text)',
  fontSize: '0.8125rem',
  textDecoration: 'none',
  marginLeft: 'auto',
};
