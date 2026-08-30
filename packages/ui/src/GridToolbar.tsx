'use client';

/**
 * The grid's chrome: filter chips, group-by, the column picker, saved views and
 * export.
 *
 * Every control here edits the same `FilterSet` / column-order / group-by state
 * a saved view stores and a deep link restores. There is no "toolbar state" and
 * "view state" -- one object, so what an operator sees is exactly what gets
 * shared.
 *
 * The filter row is deliberately chip-shaped rather than a modal query builder.
 * The recon's filter grammar is uniform across entities (54 keys on campaigns
 * alone, same shape everywhere), which is what makes chips work: one control
 * that reads `<KEY> <operator> <value>` covers every column at every level, and
 * an operator who learns it once never learns it again.
 */
import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { EntityLevel, GridColumn } from './columns.js';
import { ENTITY_LABELS, ENTITY_LEVELS, filterKindForColumn } from './columns.js';
import type { Filter, FilterOperator, FilterSet } from './filter.js';
import { columnIdToFilterKey, filterKeyToColumnId } from './filter.js';
import {
  buildCategoricalOptions,
  searchFilterOptions,
  selectAllFilterOptions,
  toggleFilterOption,
} from './filter-options.js';
import { formatInteger } from './format.js';
import { metricSpec } from './metrics.js';
import type { GridModel } from './pipeline.js';
import { parseFieldId } from './rows.js';
import type { GridRow } from './rows.js';
import type { SavedView } from './views.js';
import { tokens } from './theme.js';

export interface GridToolbarProps {
  entity: EntityLevel;
  onEntityChange?: (entity: EntityLevel) => void;
  /** Every column available at this level, for the picker and the filter key list. */
  available: readonly GridColumn[];
  /** Visible column ids, in order. */
  visible: readonly string[];
  onVisibleChange: (columnIds: string[]) => void;
  filter: FilterSet;
  onFilterChange: (filter: FilterSet) => void;
  groupBy: readonly string[];
  onGroupByChange: (columnIds: string[]) => void;
  model: GridModel;
  /** Complete authorized rows, before filters, used only to derive categorical choices. */
  optionRows?: readonly GridRow[];
  onExport?: () => void;
  views?: readonly SavedView[];
  onApplyView?: (view: SavedView) => void;
  onSaveView?: (name: string) => void;
  /** Rendered to the right of the counts: freshness, crosscheck chip, anything. */
  children?: ReactNode;
}

const NUMERIC_OPERATORS: readonly FilterOperator[] = ['>', '>=', '<', '<=', '=', '<>'];
const TEXT_OPERATORS: readonly FilterOperator[] = ['LIKE', 'NOT_LIKE', '=', '<>'];
const CATEGORICAL_OPERATORS: readonly FilterOperator[] = ['IN', 'NOT_IN'];
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  LIKE: 'contains',
  NOT_LIKE: 'does not contain',
  '=': 'equals',
  '<>': 'does not equal',
  IN: 'is one of',
  NOT_IN: 'is not one of',
  '>': 'greater than',
  '>=': 'at least',
  '<': 'less than',
  '<=': 'at most',
  IS_NULL: 'is empty',
  IS_NOT_NULL: 'is not empty',
};

/**
 * Which operators a column accepts.
 *
 * Numeric and text columns take disjoint operator sets, so the operator control
 * has to be re-derived when the column changes -- and the draft operator has to
 * be *coerced* into the new set, not merely re-rendered. A `<select>` whose
 * `value` is absent from its options renders the first option while the state
 * behind it still holds the old one, so the toolbar silently submits `SEARCH_TERM > x`
 * while showing `LIKE`. Found by driving the real UI; it threw a `FilterError`
 * from inside render and blanked the page.
 */
function operatorsFor(column: GridColumn | undefined): readonly FilterOperator[] {
  if (column === undefined) return TEXT_OPERATORS;
  const kind = filterKindForColumn(column);
  if (kind === 'numeric') return NUMERIC_OPERATORS;
  if (kind === 'categorical') return CATEGORICAL_OPERATORS;
  return TEXT_OPERATORS;
}

export function GridToolbar(props: GridToolbarProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftOperator, setDraftOperator] = useState<FilterOperator>('LIKE');
  const [draftValue, setDraftValue] = useState('');
  const [draftValues, setDraftValues] = useState<string[]>([]);
  const [valuePickerOpen, setValuePickerOpen] = useState(false);
  const [optionSearch, setOptionSearch] = useState('');
  const valueTriggerRef = useRef<HTMLButtonElement>(null);

  const filters = props.filter.groups[0]?.filters ?? [];
  const dimensions = useMemo(
    () => props.available.filter((column) => column.kind === 'dimension'),
    [props.available],
  );
  const selectedGroupBy = useMemo(
    () => [...new Set(props.groupBy)].filter((id) => dimensions.some((column) => column.id === id)),
    [dimensions, props.groupBy],
  );

  const setFilters = (next: readonly Filter[]): void => {
    props.onFilterChange(next.length === 0 ? { groups: [] } : { groups: [{ filters: next }] });
  };

  const draftColumn = props.available.find(
    (column) => columnIdToFilterKey(column.id) === draftKey,
  );
  const draftKind = draftColumn === undefined ? 'text' : filterKindForColumn(draftColumn);
  const categoricalOptions = useMemo(
    () =>
      draftKind === 'categorical' && draftColumn !== undefined
        ? buildCategoricalOptions(props.optionRows ?? [], draftColumn.id)
        : [],
    [draftColumn, draftKind, props.optionRows],
  );
  const matchingOptions = useMemo(
    () => searchFilterOptions(categoricalOptions, optionSearch),
    [categoricalOptions, optionSearch],
  );

  const addFilter = (): void => {
    const values = draftKind === 'categorical' ? draftValues : [draftValue.trim()].filter(Boolean);
    if (draftKey === '' || values.length === 0) return;
    setFilters([
      ...filters,
      { key: draftKey, conditions: [{ operator: draftOperator, values }] },
    ]);
    setDraftValue('');
    setDraftValues([]);
    setOptionSearch('');
    setValuePickerOpen(false);
  };

  const operators = operatorsFor(draftColumn);

  /** Selecting a column re-derives the operator set and snaps the draft into it. */
  const chooseKey = (key: string): void => {
    setDraftKey(key);
    const column = props.available.find((candidate) => columnIdToFilterKey(candidate.id) === key);
    const next = operatorsFor(column);
    if (!next.includes(draftOperator)) setDraftOperator(next[0] as FilterOperator);
    setDraftValue('');
    setDraftValues([]);
    setOptionSearch('');
    setValuePickerOpen(false);
  };

  return (
    <div style={bar}>
      <div style={row} data-toolbar-row="filters">
        <select
          aria-label="Filter column"
          value={draftKey}
          onChange={(event) => chooseKey(event.target.value)}
          style={control}
        >
          <option value="">Add filter…</option>
          {props.available.map((column) => (
            <option key={column.id} value={columnIdToFilterKey(column.id)}>
              {column.header}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter operator"
          value={draftOperator}
          onChange={(event) => setDraftOperator(event.target.value as FilterOperator)}
          style={{ ...control, width: '10rem' }}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {OPERATOR_LABELS[operator]}
            </option>
          ))}
        </select>
        {draftKind === 'categorical' ? (
          <div style={valuePickerWrap}>
            <button
              ref={valueTriggerRef}
              type="button"
              aria-label="Filter values"
              aria-expanded={valuePickerOpen}
              aria-haspopup="dialog"
              onClick={() => setValuePickerOpen((open) => !open)}
              style={{ ...control, ...valueTrigger }}
            >
              {draftValues.length === 0
                ? `Choose ${draftColumn?.header.toLowerCase() ?? 'values'}…`
                : `${draftValues.length} selected`}
              <span aria-hidden>▾</span>
            </button>
            {valuePickerOpen ? (
              <div
                role="dialog"
                aria-label={`${draftColumn?.header ?? 'Filter'} values`}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  setValuePickerOpen(false);
                  valueTriggerRef.current?.focus();
                }}
                style={valuePicker}
              >
                <input
                  autoFocus
                  aria-label="Search filter values"
                  value={optionSearch}
                  onChange={(event) => setOptionSearch(event.target.value)}
                  placeholder="Search values"
                  style={{ ...control, width: '100%', boxSizing: 'border-box' }}
                />
                <div style={valuePickerActions}>
                  <button
                    type="button"
                    onClick={() =>
                      setDraftValues((selected) => selectAllFilterOptions(selected, matchingOptions))
                    }
                    disabled={matchingOptions.length === 0}
                    style={linkButton}
                  >
                    Select all{optionSearch.trim() === '' ? '' : ` (${matchingOptions.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftValues([])}
                    disabled={draftValues.length === 0}
                    style={linkButton}
                  >
                    Clear
                  </button>
                  <span style={optionCount}>{draftValues.length} selected</span>
                </div>
                <div style={optionList}>
                  {matchingOptions.slice(0, MAX_RENDERED_OPTIONS).map((option) => (
                    <label key={option.value.toLowerCase()} style={optionItem}>
                      <input
                        type="checkbox"
                        checked={draftValues.some(
                          (selected) => selected.toLowerCase() === option.value.toLowerCase(),
                        )}
                        onChange={() =>
                          setDraftValues((selected) => toggleFilterOption(selected, option.value))
                        }
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                  {matchingOptions.length === 0 ? (
                    <p style={optionEmpty}>No values match this search.</p>
                  ) : null}
                </div>
                {matchingOptions.length > MAX_RENDERED_OPTIONS ? (
                  <p style={optionHint}>
                    Showing the first {MAX_RENDERED_OPTIONS}. Search to narrow the list; Select all
                    still selects all {matchingOptions.length} matches.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <input
            aria-label="Filter value"
            value={draftValue}
            placeholder={draftColumn === undefined ? 'Choose a field' : draftColumn.header}
            onChange={(event) => setDraftValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addFilter();
            }}
            style={{ ...control, width: '9rem' }}
          />
        )}
        <button
          type="button"
          onClick={addFilter}
          disabled={draftKey === '' || (draftKind === 'categorical' ? draftValues.length === 0 : draftValue.trim() === '')}
          style={button}
        >
          Add
        </button>

      </div>

      <div style={controlsRow} data-toolbar-row="table-controls">
        {props.onEntityChange === undefined ? null : (
          <div style={segmented} role="tablist" aria-label="Entity level">
            {ENTITY_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="tab"
                aria-selected={level === props.entity}
                onClick={() => props.onEntityChange?.(level)}
                style={{
                  ...segment,
                  ...(level === props.entity ? segmentActive : {}),
                }}
              >
                {ENTITY_LABELS[level]}
              </button>
            ))}
          </div>
        )}
        {props.children}
        <div style={{ flex: 1 }} />

        <GroupingLevels
          dimensions={dimensions}
          groupBy={selectedGroupBy}
          onChange={props.onGroupByChange}
        />

        <button type="button" onClick={() => setPickerOpen((open) => !open)} style={button}>
          Columns ({props.visible.length})
        </button>

        {props.views === undefined ? null : (
          <SavedViews
            views={props.views}
            {...(props.onApplyView === undefined ? {} : { onApply: props.onApplyView })}
            {...(props.onSaveView === undefined ? {} : { onSave: props.onSaveView })}
          />
        )}

        {props.onExport === undefined ? null : (
          <button type="button" onClick={props.onExport} style={primaryButton}>
            {props.model.grouped
              ? `Export CSV (${formatInteger(props.model.exported)} deepest ${props.model.exported === 1 ? 'group' : 'groups'})`
              : `Export CSV (${formatInteger(props.model.exported)} of ${formatInteger(props.model.total)})`}
          </button>
        )}
      </div>

      {filters.length === 0 ? null : (
        <div style={row}>
          {filters.map((filter, index) => (
            <span key={`${filter.key}-${index}`} style={chip}>
              {describeFilter(filter, props.available)}
              <button
                type="button"
                aria-label={`Remove filter ${filter.key}`}
                onClick={() => setFilters(filters.filter((_, i) => i !== index))}
                style={chipClose}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" onClick={() => setFilters([])} style={linkButton}>
            Clear all
          </button>
        </div>
      )}

      {pickerOpen ? (
        <div style={picker}>
          {props.available.map((column) => {
            const checked = props.visible.includes(column.id);
            return (
              <label key={column.id} style={pickerItem} title={column.description}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    props.onVisibleChange(
                      checked
                        ? props.visible.filter((id) => id !== column.id)
                        : [...props.visible, column.id],
                    )
                  }
                />
                {column.header}
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function GroupingLevels({
  dimensions,
  groupBy,
  onChange,
}: {
  dimensions: readonly GridColumn[];
  groupBy: readonly string[];
  onChange: (columnIds: string[]) => void;
}): ReactNode {
  const remaining = dimensions.filter((column) => !groupBy.includes(column.id));
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= groupBy.length) return;
    const next = [...groupBy];
    const current = next[index];
    const displaced = next[target];
    if (current === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = current;
    onChange(next);
  };

  return (
    <div style={groupingControl} aria-label="Grouping levels">
      <span style={groupingLabel}>Group</span>
      <ol style={groupingList} aria-label="Ordered grouping levels">
        {groupBy.map((columnId, index) => {
          const label = dimensions.find((column) => column.id === columnId)?.header ?? columnId;
          return (
            <li key={columnId} style={groupingLevel}>
              <span aria-hidden style={levelNumber}>{index + 1}</span>
              <span>{label}</span>
              <button
                type="button"
                aria-label={`Move ${label} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                style={{ ...levelButton, ...(index === 0 ? levelButtonDisabled : {}) }}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={index === groupBy.length - 1}
                onClick={() => move(index, 1)}
                style={{
                  ...levelButton,
                  ...(index === groupBy.length - 1 ? levelButtonDisabled : {}),
                }}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove grouping level ${label}`}
                onClick={() => onChange(groupBy.filter((_, level) => level !== index))}
                style={levelButton}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      <select
        aria-label="Add grouping level"
        value=""
        disabled={remaining.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onChange([...groupBy, event.target.value]);
        }}
        style={control}
      >
        <option value="">{groupBy.length === 0 ? 'Group by…' : 'Add level…'}</option>
        {remaining.map((column) => (
          <option key={column.id} value={column.id}>
            {column.header}
          </option>
        ))}
      </select>
    </div>
  );
}

function SavedViews({
  views,
  onApply,
  onSave,
}: {
  views: readonly SavedView[];
  onApply?: (view: SavedView) => void;
  onSave?: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState('');
  return (
    <>
      <select
        aria-label="Saved view"
        value=""
        onChange={(event) => {
          const view = views.find((candidate) => candidate.id === event.target.value);
          if (view !== undefined) onApply?.(view);
        }}
        style={control}
      >
        <option value="">Saved views…</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      {onSave === undefined ? null : (
        <>
          <input
            aria-label="New view name"
            value={name}
            placeholder="Name this view"
            onChange={(event) => setName(event.target.value)}
            style={{ ...control, width: '9rem' }}
          />
          <button
            type="button"
            style={button}
            onClick={() => {
              if (name.trim() === '') return;
              onSave(name.trim());
              setName('');
            }}
          >
            Save view
          </button>
        </>
      )}
    </>
  );
}

/** Human-readable chip text. Percent metrics read as percents, as typed. */
export function describeFilter(filter: Filter, columns: readonly GridColumn[] = []): string {
  const columnId = filterKeyToColumnId(filter.key);
  const column = columns.find((candidate) => candidate.id === columnId);
  const ref = parseFieldId(columnId);
  const spec = ref === null ? undefined : metricSpec(ref.metric);
  const unit = spec?.scale === 'percent' || ref?.part === 'delta_percent' ? '%' : '';
  const joiner = ` ${(filter.logical_operator ?? 'AND').toLowerCase()} `;
  const parts = filter.conditions.map((condition) => {
    const shown = condition.values.slice(0, 3).join(', ');
    const remaining = Math.max(0, condition.values.length - 3);
    const summary = `${shown}${remaining === 0 ? '' : ` +${remaining} more`}`;
    return `${OPERATOR_LABELS[condition.operator ?? '=']} ${summary}${unit}`;
  });
  return `${column?.header ?? filter.key} ${parts.join(joiner)}`;
}

const bar: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.sm,
  gap: tokens.space(2),
  marginBottom: tokens.space(3),
};

const row: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(2),
};

const controlsRow: CSSProperties = {
  ...row,
  justifyContent: 'flex-end',
};

const control: CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.text,
  fontSize: tokens.font.size.sm,
  padding: `${tokens.space(1)} ${tokens.space(1.5)}`,
};

const button: CSSProperties = { ...control, background: 'transparent', cursor: 'pointer' };

const MAX_RENDERED_OPTIONS = 200;

const valuePickerWrap: CSSProperties = {
  position: 'relative',
};

const valueTrigger: CSSProperties = {
  alignItems: 'center',
  cursor: 'pointer',
  display: 'inline-flex',
  gap: tokens.space(2),
  justifyContent: 'space-between',
  minWidth: '11rem',
};

const valuePicker: CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  boxShadow: '0 16px 40px rgb(17 21 28 / 16%)',
  display: 'grid',
  gap: tokens.space(2),
  left: 0,
  minWidth: '18rem',
  padding: tokens.space(2),
  position: 'absolute',
  top: `calc(100% + ${tokens.space(1)})`,
  zIndex: 20,
};

const valuePickerActions: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: tokens.space(2),
};

const optionCount: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  marginLeft: 'auto',
};

const optionList: CSSProperties = {
  display: 'grid',
  gap: tokens.space(0.5),
  maxHeight: '15rem',
  overflowY: 'auto',
};

const optionItem: CSSProperties = {
  alignItems: 'center',
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  display: 'flex',
  gap: tokens.space(2),
  minHeight: '2rem',
  padding: `0 ${tokens.space(1)}`,
};

const optionEmpty: CSSProperties = {
  color: tokens.color.textMuted,
  margin: tokens.space(2),
};

const optionHint: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  margin: 0,
};

const primaryButton: CSSProperties = {
  ...button,
  background: tokens.color.accentGradient,
  borderColor: tokens.color.accent,
  color: tokens.color.onAccent,
  fontWeight: 650,
};

const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.accent,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  padding: 0,
};

const groupingControl: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(1),
};

const groupingLabel: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const groupingList: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(1),
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const groupingLevel: CSSProperties = {
  alignItems: 'center',
  background: tokens.color.surfaceAlt,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.sm,
  display: 'inline-flex',
  gap: tokens.space(0.5),
  padding: `${tokens.space(0.5)} ${tokens.space(1)}`,
};

const levelNumber: CSSProperties = {
  color: tokens.color.textMuted,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
};

const levelButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  lineHeight: 1,
  padding: tokens.space(0.5),
};

const levelButtonDisabled: CSSProperties = {
  cursor: 'default',
  opacity: 0.35,
};

const segmented: CSSProperties = {
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  overflow: 'hidden',
};

const segment: CSSProperties = {
  background: tokens.color.surface,
  border: 'none',
  color: tokens.color.text,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  padding: `${tokens.space(1)} ${tokens.space(3)}`,
};

const segmentActive: CSSProperties = {
  background: tokens.color.indigoSoft,
  color: tokens.color.text,
  fontWeight: 600,
};

const chip: CSSProperties = {
  alignItems: 'center',
  background: tokens.color.indigoSoft,
  border: `1px solid ${tokens.color.indigo}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.text,
  display: 'inline-flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
  padding: `${tokens.space(0.5)} ${tokens.space(2)}`,
};

const chipClose: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: tokens.font.size.base,
  lineHeight: 1,
  padding: 0,
};

const picker: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'grid',
  gap: tokens.space(1),
  gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))',
  maxHeight: '16rem',
  overflow: 'auto',
  padding: tokens.space(3),
};

const pickerItem: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
};
