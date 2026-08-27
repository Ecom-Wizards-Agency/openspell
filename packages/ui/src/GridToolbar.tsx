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
import { useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { EntityLevel, GridColumn } from './columns.js';
import { ENTITY_LABELS, ENTITY_LEVELS } from './columns.js';
import type { Filter, FilterOperator, FilterSet } from './filter.js';
import { columnIdToFilterKey, filterKeyToColumnId } from './filter.js';
import { formatInteger } from './format.js';
import { metricSpec } from './metrics.js';
import type { GridModel } from './pipeline.js';
import { parseFieldId } from './rows.js';
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
  onExport?: () => void;
  views?: readonly SavedView[];
  onApplyView?: (view: SavedView) => void;
  onSaveView?: (name: string) => void;
  /** Rendered to the right of the counts: freshness, crosscheck chip, anything. */
  children?: ReactNode;
}

const NUMERIC_OPERATORS: readonly FilterOperator[] = ['>', '>=', '<', '<=', '=', '<>'];
const TEXT_OPERATORS: readonly FilterOperator[] = ['LIKE', 'NOT_LIKE', '=', '<>', 'IN', 'NOT_IN'];
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
function operatorsFor(filterKey: string): readonly FilterOperator[] {
  if (filterKey === '') return TEXT_OPERATORS;
  return parseFieldId(filterKeyToColumnId(filterKey)) !== null ? NUMERIC_OPERATORS : TEXT_OPERATORS;
}

export function GridToolbar(props: GridToolbarProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftOperator, setDraftOperator] = useState<FilterOperator>('LIKE');
  const [draftValue, setDraftValue] = useState('');

  const filters = props.filter.groups[0]?.filters ?? [];
  const dimensions = useMemo(
    () => props.available.filter((column) => column.kind === 'dimension'),
    [props.available],
  );

  const setFilters = (next: readonly Filter[]): void => {
    props.onFilterChange(next.length === 0 ? { groups: [] } : { groups: [{ filters: next }] });
  };

  const addFilter = (): void => {
    if (draftKey === '' || draftValue.trim() === '') return;
    setFilters([
      ...filters,
      { key: draftKey, conditions: [{ operator: draftOperator, values: [draftValue.trim()] }] },
    ]);
    setDraftValue('');
  };

  const operators = operatorsFor(draftKey);
  const draftColumn = props.available.find(
    (column) => columnIdToFilterKey(column.id) === draftKey,
  );

  /** Selecting a column re-derives the operator set and snaps the draft into it. */
  const chooseKey = (key: string): void => {
    setDraftKey(key);
    const next = operatorsFor(key);
    if (!next.includes(draftOperator)) setDraftOperator(next[0] as FilterOperator);
  };

  return (
    <div style={bar}>
      <div style={row}>
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
        <div style={{ flex: 1 }} />
        {props.children}
      </div>

      <div style={row}>
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
        <button type="button" onClick={addFilter} style={button}>
          Add
        </button>

        <div style={{ width: '1px', height: '1.5rem', background: tokens.color.border }} />

        <label style={label}>
          Group by
          <select
            value={props.groupBy[0] ?? ''}
            onChange={(event) =>
              props.onGroupByChange(event.target.value === '' ? [] : [event.target.value])
            }
            style={control}
          >
            <option value="">— none —</option>
            {dimensions.map((column) => (
              <option key={column.id} value={column.id}>
                {column.header}
              </option>
            ))}
          </select>
        </label>

        <button type="button" onClick={() => setPickerOpen((open) => !open)} style={button}>
          Columns ({props.visible.length})
        </button>

        {props.onExport === undefined ? null : (
          <button type="button" onClick={props.onExport} style={button}>
            Export CSV ({formatInteger(props.model.shown)} of {formatInteger(props.model.total)})
          </button>
        )}

        {props.views === undefined ? null : (
          <SavedViews
            views={props.views}
            {...(props.onApplyView === undefined ? {} : { onApply: props.onApplyView })}
            {...(props.onSaveView === undefined ? {} : { onSave: props.onSaveView })}
          />
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
  const parts = filter.conditions.map(
    (condition) => `${OPERATOR_LABELS[condition.operator ?? '=']} ${condition.values.join(', ')}${unit}`,
  );
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

const control: CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.text,
  fontSize: tokens.font.size.sm,
  padding: `${tokens.space(1)} ${tokens.space(1.5)}`,
};

const button: CSSProperties = { ...control, cursor: 'pointer' };

const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.accent,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  padding: 0,
};

const label: CSSProperties = { alignItems: 'center', display: 'flex', gap: tokens.space(1) };

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
  background: tokens.color.accent,
  color: 'var(--wa-on-accent, #ffffff)',
  fontWeight: 600,
};

const chip: CSSProperties = {
  alignItems: 'center',
  background: tokens.color.accentSoft,
  border: '1px solid var(--wa-accent-border, #bfdbfe)',
  borderRadius: tokens.radius.pill,
  color: tokens.color.accent,
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
