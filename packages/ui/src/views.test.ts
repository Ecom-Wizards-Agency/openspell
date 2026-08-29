import { describe, expect, it } from 'vitest';
import { LocalViewStore, MemoryViewStore, newViewId } from './views.js';
import type { KeyValueStorage, SavedView } from './views.js';

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: newViewId(),
    name: 'Monday pacing',
    entity: 'campaigns',
    columns: ['campaign_name', 'spend', 'acos'],
    pinned: ['campaign_name'],
    widths: { campaign_name: 320 },
    filter: { groups: [{ filters: [{ key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] }] }] },
    sort: [{ columnId: 'spend', direction: 'desc' }],
    groupBy: [],
    dateRange: null,
    updatedAt: '2026-08-14T09:00:00Z',
    ...overrides,
  };
}

class FakeStorage implements KeyValueStorage {
  constructor(private readonly map = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  poison(key: string): void {
    this.map.set(key, '{not json');
  }
}

describe.each([
  ['memory', () => new MemoryViewStore()],
  ['local', () => new LocalViewStore(new FakeStorage())],
] as const)('%s view store', (_label, build) => {
  it('round-trips a named view and scopes the list to its entity level', async () => {
    const store = build();
    const campaigns = view();
    const terms = view({ name: 'Harvest candidates', entity: 'search_terms' });
    await store.save(campaigns);
    await store.save(terms);

    expect(await store.list('campaigns')).toEqual([campaigns]);
    expect(await store.list('search_terms')).toEqual([terms]);
    expect(await store.list('targets')).toEqual([]);
  });

  it('carries the whole lens: columns, pinning, widths, filter, sort, group-by', async () => {
    const store = build();
    const saved = view({
      entity: 'search_terms',
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    await store.save(saved);
    const [loaded] = await store.list('search_terms');
    expect(loaded).toEqual(saved);
    expect(loaded?.groupBy).toEqual(['campaign_name', 'ad_group_name', 'match_type']);
  });

  it('carries no profile id, so one view applies to any profile', async () => {
    const store = build();
    await store.save(view());
    const [loaded] = await store.list('campaigns');
    expect(Object.keys(loaded as SavedView)).not.toContain('profileId');
  });

  it('removes a view', async () => {
    const store = build();
    const saved = view();
    await store.save(saved);
    await store.remove(saved.id);
    expect(await store.list('campaigns')).toEqual([]);
  });

  it('remembers a per-entity layout separately from the named views', async () => {
    const store = build();
    const layout = view({ name: 'implicit' });
    await store.rememberLayout(layout);
    expect(await store.lastLayout('campaigns')).toEqual(layout);
    expect(await store.lastLayout('targets')).toBeNull();
    // The implicit layout is not a named view.
    expect(await store.list('campaigns')).toEqual([]);
  });

  it('sorts named views by name', async () => {
    const store = build();
    await store.save(view({ name: 'Zebra' }));
    await store.save(view({ name: 'Alpha' }));
    expect((await store.list('campaigns')).map((v) => v.name)).toEqual(['Alpha', 'Zebra']);
  });
});

describe('LocalViewStore resilience', () => {
  it('treats a corrupt entry as "no saved views" rather than throwing', async () => {
    const storage = new FakeStorage();
    const store = new LocalViewStore(storage);
    await store.save(view());
    storage.poison('wizard-ads:views:v1');

    await expect(store.list('campaigns')).resolves.toEqual([]);
    await expect(store.lastLayout('campaigns')).resolves.toBeNull();
  });

  it('survives a storage that refuses to write', async () => {
    const store = new LocalViewStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    await expect(store.save(view())).resolves.toBeUndefined();
  });
});

describe('newViewId', () => {
  it('does not collide across a batch', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newViewId()));
    expect(ids.size).toBe(500);
  });
});
