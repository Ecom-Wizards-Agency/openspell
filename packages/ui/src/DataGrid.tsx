'use client';

/**
 * The data grid.
 *
 * No pagination, ever. The recon is unambiguous about why (`02-data-grid.md`
 * §6): QA-ing an optimization means sorting four thousand rows by spend,
 * filtering to one change reason and scanning, and a server-paginated grid
 * makes that workflow physically impossible. So the whole result set is in
 * memory and the DOM holds one viewport of it.
 *
 * Division of labour:
 *
 *   `pipeline.ts`            decides which rows exist and in what order
 *   `@tanstack/react-table`  holds the column model, sizing and pinning state
 *   `@tanstack/react-virtual`decides which of those rows reach the DOM
 *   this file                renders, and owns the drag/resize/pin gestures
 *
 * Note what TanStack Table is deliberately *not* doing: filtering, sorting or
 * grouping. Its grouped row model averages what it aggregates, which is exactly
 * the failure `metrics.ts` exists to prevent, so the row model here is `core`
 * only and the rows arrive already shaped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GridColumn } from './columns.js';
import { formatDelta, formatInteger, formatValue } from './format.js';
import type { FormatContext } from './format.js';
import { metricSpec } from './metrics.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import { parseFieldId, resolveField } from './rows.js';
import type { SortRule } from './sort.js';
import { toggleSort } from './sort.js';
import { DEFAULT_OVERSCAN, DEFAULT_ROW_HEIGHT } from './virtual.js';
import { deltaColor, tokens } from './theme.js';

export interface DataGridProps {
  model: GridModel;
  /** Visible columns, in display order. */
  columns: readonly GridColumn[];
  currencyCode: string;
  locale?: string;
  sort: readonly SortRule[];
  onSortChange: (rules: SortRule[]) => void;
  /** Persisted layout callbacks. Omit and the grid is read-only chrome. */
  onWidthChange?: (columnId: string, width: number) => void;
  onPinChange?: (columnId: string, pinned: boolean) => void;
  onReorder?: (columnId: string, beforeColumnId: string | null) => void;
  onRowClick?: (row: GridRow) => void;
  /** Selected row ids are presentation state; selection interaction stays with the caller. */
  selectedRowIds?: readonly string[];
  /** Viewport height in pixels. The grid scrolls inside it; the page does not. */
  height?: number;
  rowHeight?: number;
  /** Test seam: react-virtual measures a real element, jsdom has none. */
  initialRect?: { width: number; height: number };
  /** Shown when a filter matched nothing. Not the same as having no rows at all. */
  emptyMessage?: string;
  /** Shown when the period itself produced no rows. */
  noDataMessage?: string;
}

const helper = createColumnHelper<GridRow>();

interface CellProps {
  row: GridRow;
  column: GridColumn;
  context: FormatContext;
}

function Cell({ row, column, context }: CellProps): ReactNode {
  const value = resolveField(row, column.id);
  const ref = parseFieldId(column.id);

  if (ref !== null && (ref.part === 'delta_absolute' || ref.part === 'delta_percent')) {
    const spec = metricSpec(ref.metric);
    const numeric = typeof value === 'number' ? value : null;
    return (
      <span style={{ color: deltaColor(numeric, spec?.better ?? null) }}>
        {formatDelta(numeric, column.scale, context)}
      </span>
    );
  }

  return <>{formatValue(value, column.scale, context)}</>;
}

export function DataGrid({
  model,
  columns,
  currencyCode,
  locale,
  sort,
  onSortChange,
  onWidthChange,
  onPinChange,
  onReorder,
  onRowClick,
  selectedRowIds = [],
  height = 620,
  rowHeight = DEFAULT_ROW_HEIGHT,
  initialRect,
  emptyMessage = 'No rows match this filter.',
  noDataMessage = 'Nothing was reported at this level for this period. Amazon omits zero-impression rows, so this is either a period with no activity or a report that has not loaded — the freshness banner says which.',
}: DataGridProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const formatContext = useMemo<FormatContext>(
    () => ({ currencyCode, ...(locale === undefined ? {} : { locale }) }),
    [currencyCode, locale],
  );
  const selected = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  const columnDefs = useMemo<ColumnDef<GridRow, unknown>[]>(
    () =>
      columns.map((column) =>
        helper.accessor((row) => resolveField(row, column.id), {
          id: column.id,
          header: column.header,
          size: column.width,
          cell: (info) => <Cell row={info.row.original} column={column} context={formatContext} />,
        }),
      ) as ColumnDef<GridRow, unknown>[],
    [columns, formatContext],
  );

  const pinnedIds = useMemo(
    () => columns.filter((column) => column.pinned).map((column) => column.id),
    [columns],
  );

  const table = useReactTable({
    data: model.rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    state: { columnPinning: { left: pinnedIds, right: [] } },
    getRowId: (row) => row.id,
    enableColumnResizing: true,
    columnResizeMode: 'onEnd',
  });

  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: DEFAULT_OVERSCAN,
    ...(initialRect === undefined ? {} : { initialRect }),
  });

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const paddingBottom =
    items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0) : 0;

  const handleHeaderClick = useCallback(
    (columnId: string, event: React.MouseEvent) => {
      onSortChange(toggleSort(sort, columnId, event.shiftKey));
    },
    [onSortChange, sort],
  );

  /**
   * Re-sorting or re-filtering returns you to the top.
   *
   * Sorting by spend descending and staying at row 12,000 shows you an
   * arbitrary slice of the answer you just asked for. The scroll offset is only
   * meaningful relative to an ordering, so when the ordering changes the offset
   * stops meaning anything.
   */
  const orderKey = `${sort.map((rule) => `${rule.columnId}:${rule.direction}`).join(',')}|${model.matched}|${model.grouped}`;
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = 0;
  }, [orderKey]);

  const leafColumns = table.getVisibleLeafColumns();
  const totalWidth = leafColumns.reduce((sum, column) => sum + column.getSize(), 0);
  const totalsRow = model.totalsRow;

  return (
    <div style={shell}>
      <div ref={scrollRef} style={{ ...scroller, height }} data-testid="grid-scroller">
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <div style={headerRow} role="row">
            {leafColumns.map((column) => {
              const definition = columns.find((candidate) => candidate.id === column.id);
              const rule = sort.find((entry) => entry.columnId === column.id);
              const isPinned = column.getIsPinned() === 'left';
              return (
                <div
                  key={column.id}
                  role="columnheader"
                  aria-sort={rule === undefined ? 'none' : rule.direction === 'asc' ? 'ascending' : 'descending'}
                  title={definition?.description}
                  onClick={(event) => handleHeaderClick(column.id, event)}
                  draggable={onReorder !== undefined}
                  onDragStart={() => setDragging(column.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragging !== null && dragging !== column.id) onReorder?.(dragging, column.id);
                    setDragging(null);
                  }}
                  style={{
                    ...headerCell,
                    width: column.getSize(),
                    justifyContent: definition?.align === 'right' ? 'flex-end' : 'flex-start',
                    ...(isPinned
                      ? { position: 'sticky', left: column.getStart('left'), zIndex: 3, background: tokens.color.surfaceAlt }
                      : {}),
                  }}
                >
                  <span style={headerLabel}>{flexRender(column.columnDef.header, {} as never)}</span>
                  {rule === undefined ? null : (
                    // aria-sort already tells a screen reader the direction;
                    // the glyph would only make the header's name read "Spend▼".
                    <span aria-hidden style={sortMark}>
                      {rule.direction === 'asc' ? '▲' : '▼'}
                      {sort.length > 1 ? sort.indexOf(rule) + 1 : ''}
                    </span>
                  )}
                  {onPinChange === undefined ? null : (
                    <button
                      type="button"
                      aria-label={isPinned ? `Unpin ${definition?.header ?? column.id}` : `Pin ${definition?.header ?? column.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPinChange(column.id, !isPinned);
                      }}
                      style={{ ...pinButton, opacity: isPinned ? 1 : 0.25 }}
                    >
                      ⌷
                    </button>
                  )}
                  {onWidthChange === undefined ? null : (
                    <span
                      role="separator"
                      aria-label={`Resize ${definition?.header ?? column.id}`}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        onWidthChange(column.id, autoFitWidth(definition, model, formatContext));
                      }}
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        startResize(event, column.getSize(), (width) => onWidthChange(column.id, width));
                      }}
                      style={resizeHandle}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {totalsRow === null ? null : (
            <div style={{ ...bodyRow, ...totalsRowStyle }} role="row">
              {leafColumns.map((column) => {
                const definition = columns.find((candidate) => candidate.id === column.id);
                const isPinned = column.getIsPinned() === 'left';
                const isFirst = column === leafColumns[0];
                return (
                  <div
                    key={column.id}
                    role="cell"
                    style={{
                      ...bodyCell,
                      width: column.getSize(),
                      textAlign: definition?.align ?? 'left',
                      fontWeight: 600,
                      ...(isPinned
                        ? { position: 'sticky', left: column.getStart('left'), zIndex: 2, background: tokens.color.surfaceAlt }
                        : {}),
                    }}
                  >
                    {isFirst ? (
                      `Total · ${formatInteger(model.shown, locale)} row${model.shown === 1 ? '' : 's'}`
                    ) : definition === undefined ? null : (
                      <Cell row={totalsRow} column={definition} context={formatContext} />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {rows.length === 0 ? (
            <div style={emptyState}>{model.total === 0 ? noDataMessage : emptyMessage}</div>
          ) : (
            <div style={{ paddingTop, paddingBottom }}>
              {items.map((item) => {
                const row = rows[item.index];
                if (row === undefined) return null;
                const isSelected = selected.has(row.id);
                return (
                  <div
                    key={row.id}
                    role="row"
                    aria-selected={isSelected}
                    data-testid="grid-row"
                    onClick={() => onRowClick?.(row.original)}
                    style={{
                      ...bodyRow,
                      height: item.size,
                      cursor: onRowClick === undefined ? 'default' : 'pointer',
                      background: isSelected
                        ? tokens.color.indigoSoft
                        : item.index % 2 === 0
                          ? tokens.color.surface
                          : tokens.color.surfaceAlt,
                    }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const definition = columns.find((candidate) => candidate.id === cell.column.id);
                      const isPinned = cell.column.getIsPinned() === 'left';
                      return (
                        <div
                          key={cell.id}
                          role="cell"
                          style={{
                            ...bodyCell,
                            width: cell.column.getSize(),
                            textAlign: definition?.align ?? 'left',
                            ...(isPinned
                              ? {
                                  position: 'sticky',
                                  left: cell.column.getStart('left'),
                                  zIndex: 1,
                                  background: 'inherit',
                                }
                              : {}),
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={footer}>
        <span>
          {formatInteger(model.shown, locale)} of {formatInteger(model.total, locale)} rows
          {model.grouped ? ` · grouped from ${formatInteger(model.matched, locale)}` : ''}
        </span>
        {model.grouped ? (
          <span style={{ color: tokens.color.textMuted }}>
            Ratio metrics recomputed from summed bases, never averaged.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Double-click auto-fit, copied from AdLabs' own walkthrough. Width is measured
 * from the widest rendered string rather than from the data, because that is
 * what the operator can see.
 */
function autoFitWidth(
  column: GridColumn | undefined,
  model: GridModel,
  context: FormatContext,
): number {
  if (column === undefined) return 120;
  let widest = column.header.length;
  const sample = model.rows.slice(0, 200);
  for (const row of sample) {
    const text = formatValue(resolveField(row, column.id), column.scale, context);
    if (text.length > widest) widest = text.length;
  }
  return Math.min(480, Math.max(72, widest * 8 + 28));
}

function startResize(
  event: React.MouseEvent,
  startWidth: number,
  commit: (width: number) => void,
): void {
  const startX = event.clientX;
  const onMove = (move: MouseEvent): void => {
    commit(Math.max(56, startWidth + move.clientX - startX));
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

const shell: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.base,
  overflow: 'hidden',
};

const scroller: CSSProperties = { overflow: 'auto', position: 'relative' };

/**
 * The header's height is fixed rather than derived from its padding, because
 * the totals row sticks directly beneath it and `top` has to be exactly the
 * header's height. Deriving one from the other in CSS is not possible, and
 * guessing it puts the totals row over the first data row -- which is what
 * happened before this was pinned.
 */
const HEADER_HEIGHT = 32;

const headerRow: CSSProperties = {
  background: tokens.color.surfaceAlt,
  borderBottom: `1px solid ${tokens.color.borderStrong}`,
  boxSizing: 'border-box',
  display: 'flex',
  height: HEADER_HEIGHT,
  position: 'sticky',
  top: 0,
  zIndex: 4,
};

const headerCell: CSSProperties = {
  alignItems: 'center',
  boxSizing: 'border-box',
  cursor: 'pointer',
  display: 'flex',
  fontSize: tokens.font.size.eyebrow,
  fontWeight: 600,
  gap: tokens.space(1),
  padding: `${tokens.space(1.5)} ${tokens.space(2)}`,
  position: 'relative',
  userSelect: 'none',
  whiteSpace: 'nowrap',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const headerLabel: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis' };

const sortMark: CSSProperties = { color: tokens.color.accent, fontSize: '0.625rem' };

const pinButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  fontSize: '0.625rem',
  padding: 0,
};

const resizeHandle: CSSProperties = {
  cursor: 'col-resize',
  height: '100%',
  position: 'absolute',
  right: 0,
  top: 0,
  width: '5px',
};

const bodyRow: CSSProperties = {
  borderBottom: `1px solid ${tokens.color.border}`,
  display: 'flex',
};

const totalsRowStyle: CSSProperties = {
  background: tokens.color.accentSoft,
  borderBottom: `1px solid ${tokens.color.borderStrong}`,
  position: 'sticky',
  top: HEADER_HEIGHT,
  zIndex: 3,
};

const bodyCell: CSSProperties = {
  boxSizing: 'border-box',
  fontVariantNumeric: 'tabular-nums',
  fontSize: tokens.font.size.sm,
  overflow: 'hidden',
  padding: `${tokens.space(1)} ${tokens.space(2)}`,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const emptyState: CSSProperties = {
  color: tokens.color.textMuted,
  padding: tokens.space(8),
  textAlign: 'center',
};

const footer: CSSProperties = {
  alignItems: 'center',
  borderTop: `1px solid ${tokens.color.border}`,
  color: tokens.color.text,
  display: 'flex',
  fontSize: tokens.font.size.sm,
  gap: tokens.space(3),
  justifyContent: 'space-between',
  padding: `${tokens.space(1.5)} ${tokens.space(3)}`,
};
