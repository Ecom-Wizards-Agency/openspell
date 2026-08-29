/**
 * Saved views: columns + filters + sort + group-by + date range, named.
 *
 * The recon (`02-data-grid.md` §5) found that AdLabs has *one implicit
 * remembered layout per user* -- no named presets, no per-view filter sets, no
 * sharing. Its verdict, and ours: clone the auto-persisted layout, beat it with
 * named views that bundle the lens rather than the result.
 *
 * A view is a **lens**, and that word is load-bearing: it deliberately carries
 * no profile id. "My Monday pacing view" is worth having precisely because it
 * applies to any of the profiles an agency runs; binding it to one would make
 * it fifteen views that drift apart, which is the exact failure the recon
 * records in AdLabs' dashboard duplication model (`03-dashboards.md` §6).
 *
 * ## Storage
 *
 * `ViewStore` is a port with two implementations here: in-memory (tests) and
 * `localStorage` (the browser). Both are per-user by construction because the
 * storage is. A shared, org-scoped, DB-backed store needs a `grid_views` table,
 * which belongs to WP-01's migrations -- so this file defines the interface it
 * would implement and stops there rather than inventing a schema across an
 * ownership line.
 */
import { ENTITY_LEVELS } from './columns.js';
import type { EntityLevel } from './columns.js';
import type { FilterSet } from './filter.js';
import type { SortRule } from './sort.js';

export interface DateRange {
  start: string;
  end: string;
}

export interface SavedView {
  id: string;
  name: string;
  entity: EntityLevel;
  /** Visible column ids, in display order. Order is the layout. */
  columns: readonly string[];
  /** Column ids pinned left of the pin line. */
  pinned: readonly string[];
  /** Per-column width overrides, keyed by column id. */
  widths: Readonly<Record<string, number>>;
  filter: FilterSet;
  sort: readonly SortRule[];
  /** Unique dimension ids in outermost-to-innermost hierarchy order. */
  groupBy: readonly string[];
  /**
   * Null means "whatever the page is showing". A view that pins a date range is
   * a report; a view that does not is a lens. Both are useful and they are not
   * the same object, so the difference is explicit.
   */
  dateRange: DateRange | null;
  updatedAt: string;
}

export interface ViewStore {
  list(entity: EntityLevel): Promise<SavedView[]>;
  save(view: SavedView): Promise<void>;
  remove(id: string): Promise<void>;
  /** The layout to restore on load, per entity level. AdLabs' implicit memory. */
  lastLayout(entity: EntityLevel): Promise<SavedView | null>;
  rememberLayout(view: SavedView): Promise<void>;
}

export function newViewId(): string {
  return `view_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export class MemoryViewStore implements ViewStore {
  private readonly views = new Map<string, SavedView>();
  private readonly layouts = new Map<EntityLevel, SavedView>();

  async list(entity: EntityLevel): Promise<SavedView[]> {
    return [...this.views.values()]
      .filter((view) => view.entity === entity)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(view: SavedView): Promise<void> {
    this.views.set(view.id, view);
  }

  async remove(id: string): Promise<void> {
    this.views.delete(id);
  }

  async lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return this.layouts.get(entity) ?? null;
  }

  async rememberLayout(view: SavedView): Promise<void> {
    this.layouts.set(view.entity, view);
  }
}

const NAMED_KEY = 'wizard-ads:views:v1';
const LAYOUT_KEY = 'wizard-ads:layout:v1';
const FILTER_OPERATORS = new Set([
  '>', '<', '>=', '<=', '=', '<>', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFilterSet(value: unknown): value is FilterSet {
  if (!isRecord(value) || !Array.isArray(value['groups'])) return false;
  return value['groups'].every((group) => {
    if (!isRecord(group) || !Array.isArray(group['filters'])) return false;
    return group['filters'].every((filter) => {
      if (!isRecord(filter) || typeof filter['key'] !== 'string' || !Array.isArray(filter['conditions'])) {
        return false;
      }
      if (
        filter['logical_operator'] !== undefined &&
        filter['logical_operator'] !== 'AND' &&
        filter['logical_operator'] !== 'OR'
      ) {
        return false;
      }
      return filter['conditions'].every((condition) =>
        isRecord(condition) &&
        isStringArray(condition['values']) &&
        (condition['operator'] === undefined || FILTER_OPERATORS.has(String(condition['operator']))),
      );
    });
  });
}

function isSavedView(value: unknown): value is SavedView {
  if (!isRecord(value)) return false;
  const widths = value['widths'];
  const sort = value['sort'];
  const dateRange = value['dateRange'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    ENTITY_LEVELS.includes(value['entity'] as EntityLevel) &&
    isStringArray(value['columns']) &&
    isStringArray(value['pinned']) &&
    isRecord(widths) &&
    Object.values(widths).every((width) => typeof width === 'number' && Number.isFinite(width)) &&
    isFilterSet(value['filter']) &&
    Array.isArray(sort) &&
    sort.every((rule) =>
      isRecord(rule) &&
      typeof rule['columnId'] === 'string' &&
      (rule['direction'] === 'asc' || rule['direction'] === 'desc'),
    ) &&
    isStringArray(value['groupBy']) &&
    (dateRange === null ||
      (isRecord(dateRange) && typeof dateRange['start'] === 'string' && typeof dateRange['end'] === 'string')) &&
    typeof value['updatedAt'] === 'string'
  );
}

/** Minimal shape of `window.localStorage`, so this file needs no DOM lib at rest. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Browser-backed store.
 *
 * Reads are defensive: a corrupt or half-written entry yields "no saved views"
 * rather than an exception, because a bad JSON blob in a user's browser must
 * never be able to blank the grid. It is a cache of a preference, not data.
 */
export class LocalViewStore implements ViewStore {
  constructor(private readonly storage: KeyValueStorage) {}

  private readRecord(key: string): Record<string, unknown> {
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private readViews(key: string): Record<string, SavedView> {
    const valid: Record<string, SavedView> = {};
    for (const [id, candidate] of Object.entries(this.readRecord(key))) {
      if (isSavedView(candidate)) valid[id] = candidate;
    }
    return valid;
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota, private mode, a disabled storage API: losing a layout preference
      // is not worth breaking a render over.
    }
  }

  async list(entity: EntityLevel): Promise<SavedView[]> {
    const all = this.readViews(NAMED_KEY);
    return Object.values(all)
      .filter((view) => view.entity === entity)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(view: SavedView): Promise<void> {
    const all = this.readViews(NAMED_KEY);
    all[view.id] = view;
    this.write(NAMED_KEY, all);
  }

  async remove(id: string): Promise<void> {
    const all = this.readViews(NAMED_KEY);
    delete all[id];
    this.write(NAMED_KEY, all);
  }

  async lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    const candidate = this.readRecord(LAYOUT_KEY)[entity];
    return isSavedView(candidate) && candidate.entity === entity ? candidate : null;
  }

  async rememberLayout(view: SavedView): Promise<void> {
    const all = this.readViews(LAYOUT_KEY);
    all[view.entity] = view;
    this.write(LAYOUT_KEY, all);
  }
}
