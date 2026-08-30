'use client';

/**
 * The grid workspace: everything interactive on `/grid`.
 *
 * One piece of state, `view`, holds columns, pinning, widths, filters, sort and
 * group-by — the same object a saved view stores and a deep link would restore.
 * There is no separate "toolbar state", which is what makes "share this lens"
 * a two-line feature rather than a refactor.
 *
 * The pipeline runs inside a `useMemo` keyed on the rows and the view, so
 * typing in a filter box re-runs filter → group → sort → total once per
 * keystroke over the whole set. The 50k perf suite is what says that is
 * affordable; without it this component would be a guess.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  DataGrid,
  BASE_METRICS,
  GridToolbar,
  LocalViewStore,
  STATE_COLUMN,
  buildGridModelSafely,
  columnsFor,
  defaultVisibleColumns,
  formatInteger,
  newViewId,
  toCsv,
} from '@wizard-ads/ui';
import type {
  EntityLevel,
  FilterSet,
  FreshnessAssessment,
  GridColumn,
  GridRow,
  SavedView,
  SortRule,
  ViewStore,
} from '@wizard-ads/ui';
import { FreshnessBanner, tokens } from '@wizard-ads/ui';
import type { GridPayload } from '../_lib/grid-data';
import { BidHistoryModal } from '../../src/ui/bid-history-modal';

export interface GridWorkspaceProps {
  entity: EntityLevel;
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  comparisonPeriod: { start: string; end: string };
  freshness: FreshnessAssessment;
  /** Streamed server-owned crosscheck state; it never blocks the data grid. */
  crosscheck?: ReactNode;
  /** Campaign deep-link applied as a visible grid filter. */
  campaignId: string | null;
  /** Test seam for proving delayed restoration. Production uses browser localStorage. */
  viewStore?: ViewStore | null;
}

interface ReadyGridWorkspaceProps extends GridWorkspaceProps {
  rows: readonly GridRow[];
}

type GridLoadState =
  | { status: 'loading'; scope: string }
  | { status: 'ready'; scope: string; payload: GridPayload }
  | { status: 'error'; scope: string };

interface InFlightGridRequest {
  scope: string;
  controller: AbortController;
  promise: Promise<GridPayload>;
  settled: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTotals(value: unknown): value is GridRow['totals'] {
  return (
    isRecord(value) &&
    BASE_METRICS.every((metric) =>
      typeof value[metric] === 'number' && Number.isFinite(value[metric]),
    )
  );
}

function isGridRow(value: unknown): value is GridRow {
  if (!isRecord(value) || typeof value['id'] !== 'string') return false;
  if (typeof value['currencyCode'] !== 'string' || !isRecord(value['dimensions'])) return false;
  if (!Object.values(value['dimensions']).every((dimension) =>
    dimension === null || ['string', 'number', 'boolean'].includes(typeof dimension),
  )) return false;
  if (!isTotals(value['totals'])) return false;
  if (value['comparison'] !== null && !isTotals(value['comparison'])) return false;
  const tagIds = value['tagIds'];
  return tagIds === undefined || (Array.isArray(tagIds) && tagIds.every((tag) => typeof tag === 'string'));
}

/** Refuse partial or malformed transport data before it becomes actionable. */
export function parseGridRowsPayload(value: unknown): GridPayload {
  if (!isRecord(value) || !Array.isArray(value['rows'])) {
    throw new Error('Grid response does not contain rows');
  }
  if (typeof value['truncated'] !== 'boolean') {
    throw new Error('Grid response does not declare truncation');
  }
  if (!Number.isInteger(value['rowCount']) || Number(value['rowCount']) < 0) {
    throw new Error('Grid response does not contain a valid row count');
  }
  if (Number(value['rowCount']) !== value['rows'].length) {
    throw new Error('Grid response row count does not match its rows');
  }
  if (!value['rows'].every(isGridRow)) throw new Error('Grid response contains an invalid row');
  return {
    rows: value['rows'],
    rowCount: Number(value['rowCount']),
    truncated: value['truncated'],
  };
}

export function gridRowsRequestUrl(
  props: Pick<GridWorkspaceProps, 'profileId' | 'entity' | 'period'>,
): string {
  const query = new URLSearchParams({
    profile: props.profileId,
    entity: props.entity,
    from: props.period.start,
    to: props.period.end,
  });
  return `/api/grid/rows?${query.toString()}`;
}

function startGridRequest(scope: string): InFlightGridRequest {
  const controller = new AbortController();
  const promise = fetch(scope, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Grid request failed with ${response.status}`);
    return parseGridRowsPayload(await response.json());
  });
  const request: InFlightGridRequest = {
    scope,
    controller,
    promise,
    settled: false,
    abortTimer: null,
  };
  void promise.then(
    () => { request.settled = true; },
    () => { request.settled = true; },
  );
  return request;
}

/**
 * The default view, matching AdLabs' enabled-only default — but as a *visible*
 * filter chip rather than a hidden server-side exclusion.
 *
 * The recon's sharpest finding about that default (`02-data-grid.md` §3): their
 * campaign entity returns only ENABLED and PAUSED, never ARCHIVED, so a month
 * total silently excludes archived spend and will not reconcile against Amazon.
 * Ours applies the same default and shows it, so removing it is one click and
 * the exclusion is never invisible.
 */
function defaultView(entity: EntityLevel, campaignId: string | null): SavedView {
  const stateColumn = STATE_COLUMN[entity];
  const filter: FilterSet =
    campaignId !== null && entity === 'campaigns'
      ? {
          groups: [
            {
              filters: [
                {
                  key: 'CAMPAIGN_ID',
                  conditions: [{ operator: '=', values: [campaignId] }],
                },
              ],
            },
          ],
        }
      : stateColumn === undefined
      ? { groups: [] }
      : {
          groups: [
            {
              filters: [
                {
                  key: stateColumn.toUpperCase(),
                  conditions: [{ operator: 'IN', values: ['enabled'] }],
                },
              ],
            },
          ],
        };

  return {
    id: 'default',
    name: 'Default',
    entity,
    columns: defaultVisibleColumns(entity),
    pinned: columnsFor(entity).filter((column) => column.pinned).map((column) => column.id),
    widths: {},
    filter,
    sort: [{ columnId: 'spend', direction: 'desc' }],
    groupBy: [],
    dateRange: null,
    updatedAt: new Date().toISOString(),
  };
}

/** How each entity level's rows map into an experiment's scope. */
const SCOPE_PARAM: Partial<Record<EntityLevel, { param: string; key: string }>> = {
  campaigns: { param: 'campaigns', key: 'campaign_id' },
  ad_groups: { param: 'adgroups', key: 'ad_group_id' },
  targets: { param: 'targets', key: 'target_id' },
  search_terms: { param: 'terms', key: 'search_term' },
};

/** Stable first-seen scope with a hard URL-size bound and no full-array pipeline. */
export function experimentScopeIds(rows: readonly GridRow[], key: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row.dimensions[key];
    if (value === null || value === undefined) continue;
    const id = String(value);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === 100) break;
  }
  return ids;
}

export function GridWorkspace(props: GridWorkspaceProps): ReactNode {
  const scope = gridRowsRequestUrl(props);
  const generation = useRef(0);
  const activeRequest = useRef<InFlightGridRequest | null>(null);
  const [retry, setRetry] = useState(0);
  const [load, setLoad] = useState<GridLoadState>({ status: 'loading', scope });

  useEffect(() => {
    const requestGeneration = ++generation.current;
    setLoad({ status: 'loading', scope });
    let request = activeRequest.current;
    if (request === null || request.scope !== scope || request.settled) {
      request = startGridRequest(scope);
      activeRequest.current = request;
    } else if (request.abortTimer !== null) {
      clearTimeout(request.abortTimer);
      request.abortTimer = null;
    }

    void request.promise
      .then((payload) => {
        if (!request.controller.signal.aborted && generation.current === requestGeneration) {
          setLoad({ status: 'ready', scope, payload });
        }
      })
      .catch((error: unknown) => {
        if (request.controller.signal.aborted || generation.current !== requestGeneration) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoad({ status: 'error', scope });
      });

    return () => {
      if (request.settled) return;
      // React development Strict Mode immediately re-runs an effect after its
      // cleanup. Give that same-scope run one task to reclaim the in-flight
      // request; a real unmount or scope change leaves the timer in place and
      // aborts it. This keeps one network request per settled Grid scope.
      request.abortTimer = setTimeout(() => request.controller.abort(), 0);
    };
  }, [retry, scope]);

  // A prop change renders before its effect runs. Treat a state object from the
  // previous scope as loading immediately so stale tenant or period rows never
  // flash while React schedules the replacement request.
  const current: GridLoadState = load.scope === scope ? load : { status: 'loading', scope };

  return (
    <div className="wa-embed" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
      <FreshnessBanner assessment={props.freshness}>
        {props.crosscheck ?? null}
      </FreshnessBanner>

      {current.status === 'loading' ? (
        <section
          aria-busy="true"
          aria-live="polite"
          className="wa-card"
          data-testid="grid-data-loading"
          style={loadPanelStyle}
        >
          <strong>Loading the complete result set…</strong>
          <span style={{ color: tokens.color.textMuted }}>
            Filters, grouping, totals, and export become available together.
          </span>
        </section>
      ) : current.status === 'error' ? (
        <section role="alert" className="wa-card" data-testid="grid-data-error" style={loadPanelStyle}>
          <strong>Grid data could not be loaded.</strong>
          <span style={{ color: tokens.color.textMuted }}>
            No partial rows are shown. Check the connection and try again.
          </span>
          <div>
            <button
              type="button"
              className="wa-btn wa-btn--sm"
              onClick={() => {
                setLoad({ status: 'loading', scope });
                setRetry((currentRetry) => currentRetry + 1);
              }}
            >
              Retry
            </button>
          </div>
        </section>
      ) : (
        <>
          <p className="wa-sr-only" role="status" data-testid="grid-row-count">
            {current.payload.truncated ? 'Partial' : 'Complete'} result set loaded:{' '}
            {formatInteger(current.payload.rowCount)} rows.
          </p>
          {current.payload.truncated ? (
            <p style={{ ...filterErrorStyle, margin: 0 }}>
              This result is too large to load safely. The set below is truncated to{' '}
              {formatInteger(current.payload.rowCount)} rows, and its totals cover only what is
              shown. Narrow the period or entity level for a complete read.
            </p>
          ) : null}
          <ReadyGridWorkspace {...props} rows={current.payload.rows} />
        </>
      )}
    </div>
  );
}

function ReadyGridWorkspace(props: ReadyGridWorkspaceProps): ReactNode {
  const router = useRouter();
  const available = useMemo(() => columnsFor(props.entity), [props.entity]);
  const [view, setView] = useState<SavedView>(() => defaultView(props.entity, props.campaignId));
  const [saved, setSaved] = useState<readonly SavedView[]>([]);
  const [restoredScope, setRestoredScope] = useState<{
    key: string;
    store: ViewStore | null;
  } | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [browserStore] = useState(() =>
    typeof window === 'undefined' ? null : new LocalViewStore(window.localStorage),
  );
  const store = props.viewStore === undefined ? browserStore : props.viewStore;
  const scopeKey = `${props.entity}\u0000${props.campaignId ?? ''}`;
  // Readiness belongs to the exact entity/deep-link scope that was restored.
  // Deriving it from the current props prevents one render of stale `true`
  // before an effect can reset a boolean after a client-side route change.
  const viewReady = restoredScope?.key === scopeKey && restoredScope.store === store;

  // Restore the implicit layout AdLabs remembers per user, and list the named
  // views we have that they do not.
  useEffect(() => {
    if (store === null) {
      setView(defaultView(props.entity, props.campaignId));
      setSaved([]);
      setSelectedTargetId(null);
      setRestoredScope({ key: scopeKey, store });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [layout, list] = await Promise.all([
          store.lastLayout(props.entity),
          store.list(props.entity),
        ]);
        if (cancelled) return;
        if (props.campaignId !== null) setView(defaultView(props.entity, props.campaignId));
        else if (layout !== null) {
          setView(withValidGrouping({ ...layout, id: 'default', name: 'Default' }, available));
        }
        else setView(defaultView(props.entity, null));
        setSaved(list);
      } catch {
        if (cancelled) return;
        // Browser storage is a preference cache. A rejected custom/remote
        // store must not strand the analytical grid behind a permanent loader.
        setView(defaultView(props.entity, props.campaignId));
        setSaved([]);
      }
      setSelectedTargetId(null);
      // This is deliberately later than hydration alone. An interaction that
      // lands after React attaches but before the saved layout resolves can be
      // overwritten by the restoration above just as surely as a pre-hydration
      // interaction can be lost. The restored scope opens only the matching
      // entity/deep-link workspace, never a later render with different props.
      setRestoredScope({ key: scopeKey, store });
    })();
    return () => {
      cancelled = true;
    };
  }, [available, props.campaignId, props.entity, scopeKey, store]);

  const update = useCallback(
    (patch: Partial<SavedView>) => {
      if (!viewReady) return;
      setView((current) => {
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        void store?.rememberLayout(next);
        return next;
      });
    },
    [store, viewReady],
  );

  const { model, filterError } = useMemo(
    () =>
      buildGridModelSafely(props.rows, {
        filter: view.filter,
        sort: view.sort,
        groupBy: view.groupBy,
      }),
    [props.rows, view.filter, view.sort, view.groupBy],
  );

  /**
   * Visible columns, in the operator's order.
   *
   * When a group-by is active only the group key and the metrics can be shown:
   * every other dimension was legitimately dropped by the aggregation, and
   * rendering an empty column with a header is worse than not rendering it.
   */
  const visibleColumns = useMemo<GridColumn[]>(() => {
    const byId = new Map(available.map((column) => [column.id, column]));
    const wanted = model.grouped
      ? [...model.groupBy, ...view.columns.filter((id) => byId.get(id)?.kind === 'metric')]
      : view.columns;
    return wanted
      .map((id) => byId.get(id))
      .filter((column): column is GridColumn => column !== undefined)
      .map((column) => {
        const width = view.widths[column.id];
        const pinned = view.pinned.includes(column.id);
        return { ...column, ...(width === undefined ? {} : { width }), pinned };
      });
  }, [available, model.groupBy, model.grouped, view.columns, view.pinned, view.widths]);

  const handleExport = useCallback(() => {
    if (!viewReady) return;
    const result = toCsv(model, {
      columns: visibleColumns,
      label: props.entity.replace('_', ' '),
      currencyCode: props.currencyCode,
      period: props.period,
      comparisonPeriod: props.comparisonPeriod,
    });
    downloadCsv(result.csv, result.filename);
  }, [model, props.comparisonPeriod, props.currencyCode, props.entity, props.period, viewReady, visibleColumns]);

  const handleSaveView = useCallback(
    (name: string) => {
      if (!viewReady || store === null) return;
      const toSave: SavedView = { ...view, groupBy: model.groupBy, id: newViewId(), name };
      void store.save(toSave).then(() => store.list(props.entity)).then(setSaved);
    },
    [model.groupBy, props.entity, store, view, viewReady],
  );

  const handleReorder = useCallback(
    (columnId: string, beforeColumnId: string | null) => {
      if (!viewReady) return;
      const remaining = view.columns.filter((id) => id !== columnId);
      const at = beforeColumnId === null ? remaining.length : remaining.indexOf(beforeColumnId);
      remaining.splice(at < 0 ? remaining.length : at, 0, columnId);
      update({ columns: remaining });
    },
    [update, view.columns, viewReady],
  );

  /**
   * "Start an experiment from this view" (WP-19): carry the ids of the currently
   * filtered rows into the new-experiment form, so the scope is pre-filled with
   * what the operator has selected in the grid. Additive — a link, not a change
   * to the grid or its model.
   */
  const experimentHref = useMemo(() => {
    const mapping = SCOPE_PARAM[props.entity];
    if (mapping === undefined) return null;
    const ids = experimentScopeIds(model.matchedRows, mapping.key);
    if (ids.length === 0) return null;
    const params = new URLSearchParams({ profile: props.profileId, entity: props.entity });
    params.set(mapping.param, ids.join(','));
    return `/experiments/new?${params.toString()}`;
  }, [model.matchedRows, props.entity, props.profileId]);

  return (
    // `wa-embed` sets the inherited text colour and chromes the bare controls
    // WP-06 ships without an inline palette (inputs, selects, toolbar buttons).
    // The grid's own cells need nothing here: `packages/ui` writes
    // `var(--wa-*, <literal>)` and reads the tokens directly.
    <div
      data-testid="grid-data-ready"
      data-ready={viewReady ? 'true' : 'false'}
      aria-busy={!viewReady}
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}
    >
      <div data-testid="grid-toolbar-readiness" aria-busy={!viewReady}>
        {viewReady ? (
          <GridToolbar
            entity={props.entity}
            onEntityChange={(entity) => {
              const params = new URLSearchParams({
                profile: props.profileId,
                entity,
                from: props.period.start,
                to: props.period.end,
              });
              router.push(`/grid?${params.toString()}`);
            }}
            available={available}
            visible={view.columns}
            onVisibleChange={(columns) => update({ columns })}
            filter={view.filter}
            onFilterChange={(filter) => update({ filter })}
            groupBy={model.groupBy}
            onGroupByChange={(groupBy) => update({ groupBy })}
            model={model}
            optionRows={props.rows}
            onExport={handleExport}
            views={saved}
            onApplyView={(applied) => setView(withValidGrouping(applied, available))}
            onSaveView={handleSaveView}
          />
        ) : (
          <p role="status" data-testid="grid-layout-restoring" className="wa-hint">
            Restoring your saved grid layout…
          </p>
        )}
      </div>

      {!viewReady || experimentHref === null ? null : (
        <div className="wa-row" style={{ justifyContent: 'flex-end' }}>
          <Link
            href={experimentHref}
            prefetch={false}
            data-testid="grid-start-experiment"
            className="wa-btn wa-btn--sm"
          >
            Start an experiment from this view →
          </Link>
        </div>
      )}

      {viewReady && props.entity === 'targets' ? (
        <p className="wa-grid-context-hint">
          Select a target row to open its bid-corridor history, including the current bid,
          Amazon’s suggested range, realized CPC, and maximum potential CPC.
        </p>
      ) : null}

      {!viewReady || filterError === null ? null : (
        <p role="alert" style={filterErrorStyle}>
          Filter not applied — {filterError}. Every row is shown until the filter is fixed or
          removed.
        </p>
      )}

      {viewReady ? (
        <DataGrid
          model={model}
          columns={visibleColumns}
          currencyCode={props.currencyCode}
          sort={view.sort}
          onSortChange={(sort: SortRule[]) => update({ sort })}
          onWidthChange={(columnId, width) => update({ widths: { ...view.widths, [columnId]: width } })}
          onPinChange={(columnId, pinned) =>
            update({
              pinned: pinned
                ? [...view.pinned, columnId]
                : view.pinned.filter((id) => id !== columnId),
            })
          }
          onReorder={handleReorder}
          rowHeight={props.entity === 'targets' ? 42 : 30}
          {...(props.entity === 'targets'
            ? {
                onRowClick: (row: GridRow) => {
                  const targetId = row.dimensions['target_id'];
                  if (targetId !== null && targetId !== undefined) setSelectedTargetId(String(targetId));
                },
              }
            : {})}
        />
      ) : null}

      {!viewReady || selectedTargetId === null ? null : (
        <BidHistoryModal
          profileId={props.profileId}
          targetId={selectedTargetId}
          window={props.period}
          currencyCode={props.currencyCode}
          onClose={() => setSelectedTargetId(null)}
        />
      )}
    </div>
  );
}

export function withValidGrouping(view: SavedView, available: readonly GridColumn[]): SavedView {
  const dimensions = new Set(
    available.filter((column) => column.kind === 'dimension').map((column) => column.id),
  );
  const requested = Array.isArray(view.groupBy)
    ? view.groupBy.filter((columnId): columnId is string => typeof columnId === 'string')
    : [];
  return {
    ...view,
    groupBy: [...new Set(requested)].filter((columnId) => dimensions.has(columnId)),
  };
}

/**
 * Hand the file to the browser.
 *
 * An object URL rather than a data URI: a 50k-row export is comfortably past
 * the length a data URI survives in several browsers, and silently truncating
 * an export is the worst possible failure for a file somebody is about to
 * reconcile against Amazon.
 */
const filterErrorStyle = {
  background: tokens.color.badSoft,
  border: `1px solid ${tokens.color.badBorder}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.bad,
  fontSize: tokens.font.size.sm,
  margin: 0,
  padding: `${tokens.space(2)} ${tokens.space(3)}`,
};

const loadPanelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: tokens.space(2),
  padding: tokens.space(4),
};

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
