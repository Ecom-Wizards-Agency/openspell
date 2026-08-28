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
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DataGrid,
  GridToolbar,
  LocalViewStore,
  STATE_COLUMN,
  buildGridModelSafely,
  columnsFor,
  defaultVisibleColumns,
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
} from '@wizard-ads/ui';
import { FreshnessBanner, tokens } from '@wizard-ads/ui';
import type { VerdictChip } from '@wizard-ads/crosscheck-cli/pure';
import { CrosscheckChip } from '../crosscheck/panel';
import { BidHistoryModal } from '../../src/ui/bid-history-modal';

export interface GridWorkspaceProps {
  entity: EntityLevel;
  rows: readonly GridRow[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  comparisonPeriod: { start: string; end: string };
  freshness: FreshnessAssessment;
  chip: VerdictChip | null;
  /** Campaign deep-link applied as a visible grid filter. */
  campaignId: string | null;
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

export function GridWorkspace(props: GridWorkspaceProps): ReactNode {
  const available = useMemo(() => columnsFor(props.entity), [props.entity]);
  const [view, setView] = useState<SavedView>(() => defaultView(props.entity, props.campaignId));
  const [saved, setSaved] = useState<readonly SavedView[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [store] = useState(() =>
    typeof window === 'undefined' ? null : new LocalViewStore(window.localStorage),
  );

  // Restore the implicit layout AdLabs remembers per user, and list the named
  // views we have that they do not.
  useEffect(() => {
    if (store === null) return;
    let cancelled = false;
    void (async () => {
      const [layout, list] = await Promise.all([store.lastLayout(props.entity), store.list(props.entity)]);
      if (cancelled) return;
      if (props.campaignId !== null) setView(defaultView(props.entity, props.campaignId));
      else if (layout !== null) {
        setView(withValidGrouping({ ...layout, id: 'default', name: 'Default' }, available));
      }
      else setView(defaultView(props.entity, null));
      setSaved(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [available, props.campaignId, props.entity, store]);

  const update = useCallback(
    (patch: Partial<SavedView>) => {
      setView((current) => {
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        void store?.rememberLayout(next);
        return next;
      });
    },
    [store],
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
    const result = toCsv(model, {
      columns: visibleColumns,
      label: props.entity.replace('_', ' '),
      currencyCode: props.currencyCode,
      period: props.period,
      comparisonPeriod: props.comparisonPeriod,
    });
    downloadCsv(result.csv, result.filename);
  }, [model, props.comparisonPeriod, props.currencyCode, props.entity, props.period, visibleColumns]);

  const handleSaveView = useCallback(
    (name: string) => {
      if (store === null) return;
      const toSave: SavedView = { ...view, groupBy: model.groupBy, id: newViewId(), name };
      void store.save(toSave).then(() => store.list(props.entity)).then(setSaved);
    },
    [model.groupBy, props.entity, store, view],
  );

  const handleReorder = useCallback(
    (columnId: string, beforeColumnId: string | null) => {
      const remaining = view.columns.filter((id) => id !== columnId);
      const at = beforeColumnId === null ? remaining.length : remaining.indexOf(beforeColumnId);
      remaining.splice(at < 0 ? remaining.length : at, 0, columnId);
      update({ columns: remaining });
    },
    [update, view.columns],
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
    const ids = Array.from(
      new Set(
        model.exportRows
          .map((row) => row.dimensions[mapping.key])
          .filter((value): value is string | number => value !== null && value !== undefined)
          .map((value) => String(value)),
      ),
    ).slice(0, 100);
    if (ids.length === 0) return null;
    const params = new URLSearchParams({ profile: props.profileId, entity: props.entity });
    params.set(mapping.param, ids.join(','));
    return `/experiments/new?${params.toString()}`;
  }, [model.exportRows, props.entity, props.profileId]);

  return (
    // `wa-embed` sets the inherited text colour and chromes the bare controls
    // WP-06 ships without an inline palette (inputs, selects, toolbar buttons).
    // The grid's own cells need nothing here: `packages/ui` writes
    // `var(--wa-*, <literal>)` and reads the tokens directly.
    <div className="wa-embed" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space(3) }}>
      <FreshnessBanner assessment={props.freshness}>
        {props.chip === null ? null : <CrosscheckChip chip={props.chip} />}
      </FreshnessBanner>

      <GridToolbar
        entity={props.entity}
        onEntityChange={(entity) => {
          window.location.href = `/grid?profile=${props.profileId}&entity=${entity}&from=${props.period.start}&to=${props.period.end}`;
        }}
        available={available}
        visible={view.columns}
        onVisibleChange={(columns) => update({ columns })}
        filter={view.filter}
        onFilterChange={(filter) => update({ filter })}
        groupBy={model.groupBy}
        onGroupByChange={(groupBy) => update({ groupBy })}
        model={model}
        onExport={handleExport}
        views={saved}
        onApplyView={(applied) => setView(withValidGrouping(applied, available))}
        onSaveView={handleSaveView}
      />

      {experimentHref === null ? null : (
        <div className="wa-row" style={{ justifyContent: 'flex-end' }}>
          <a
            href={experimentHref}
            data-testid="grid-start-experiment"
            className="wa-btn wa-btn--sm"
          >
            Start an experiment from this view →
          </a>
        </div>
      )}

      {filterError === null ? null : (
        <p role="alert" style={filterErrorStyle}>
          Filter not applied — {filterError}. Every row is shown until the filter is fixed or
          removed.
        </p>
      )}

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

      {selectedTargetId === null ? null : (
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

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
