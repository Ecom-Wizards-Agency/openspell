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

export interface GridWorkspaceProps {
  entity: EntityLevel;
  rows: readonly GridRow[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  comparisonPeriod: { start: string; end: string };
  freshness: FreshnessAssessment;
  chip: VerdictChip | null;
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
function defaultView(entity: EntityLevel): SavedView {
  const stateColumn = STATE_COLUMN[entity];
  const filter: FilterSet =
    stateColumn === undefined
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

export function GridWorkspace(props: GridWorkspaceProps): ReactNode {
  const available = useMemo(() => columnsFor(props.entity), [props.entity]);
  const [view, setView] = useState<SavedView>(() => defaultView(props.entity));
  const [saved, setSaved] = useState<readonly SavedView[]>([]);
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
      if (layout !== null) setView({ ...layout, id: 'default', name: 'Default' });
      else setView(defaultView(props.entity));
      setSaved(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.entity, store]);

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
      ? [...view.groupBy, ...view.columns.filter((id) => byId.get(id)?.kind === 'metric')]
      : view.columns;
    return wanted
      .map((id) => byId.get(id))
      .filter((column): column is GridColumn => column !== undefined)
      .map((column) => {
        const width = view.widths[column.id];
        const pinned = view.pinned.includes(column.id);
        return { ...column, ...(width === undefined ? {} : { width }), pinned };
      });
  }, [available, model.grouped, view.columns, view.groupBy, view.pinned, view.widths]);

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
      const toSave: SavedView = { ...view, id: newViewId(), name };
      void store.save(toSave).then(() => store.list(props.entity)).then(setSaved);
    },
    [props.entity, store, view],
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

  return (
    // `wa-embed` re-points WP-06's inline palette at the design-system tokens so
    // the DataGrid and its toolbar follow dark mode; WP-21 does not own
    // `packages/ui`, so this bridge stands in until that package moves to tokens.
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
        groupBy={view.groupBy}
        onGroupByChange={(groupBy) => update({ groupBy })}
        model={model}
        onExport={handleExport}
        views={saved}
        onApplyView={(applied) => setView(applied)}
        onSaveView={handleSaveView}
      />

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
      />
    </div>
  );
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
