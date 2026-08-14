'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { CampaignTagListRow, JsonValue } from '@wizard-ads/db';
import { tagFilterFromState, tagFilterState } from '../../src/tags/filter';
import type { TagDescendants, TagFilter } from '../../src/tags/filter';
import { useTagFilter } from '../../src/tags/use-tag-filter';

interface UiTag {
  id: string;
  parentId: string | null;
  name: string;
  color: string | null;
  children: UiTag[];
}

interface TagManagerProps {
  tags: UiTag[];
  campaigns: CampaignTagListRow[];
  initialState?: JsonValue;
}

const panel = {
  border: '1px solid var(--wa-border)',
  borderRadius: 10,
  padding: 18,
  background: 'var(--wa-surface)',
} as const;

function flattenTags(tags: readonly UiTag[]): UiTag[] {
  return tags.flatMap((tag) => [tag, ...flattenTags(tag.children)]);
}

function descendantMap(tags: readonly UiTag[]): TagDescendants {
  const result: Record<string, string[]> = {};
  const visit = (tag: UiTag): string[] => {
    const descendants = tag.children.flatMap((child) => [child.id, ...visit(child)]);
    result[tag.id] = descendants;
    return descendants;
  };
  tags.forEach(visit);
  return result;
}

async function mutate(path: string, method: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `${method} failed (${response.status})`);
  }
}

export function TagManager({ tags, campaigns, initialState }: TagManagerProps) {
  const allTags = useMemo(() => flattenTags(tags), [tags]);
  const descendants = useMemo(() => descendantMap(tags), [tags]);
  const [filter, setFilter] = useState<TagFilter>(() => tagFilterFromState(initialState));
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [bulkTagId, setBulkTagId] = useState('');
  const [message, setMessage] = useState('');
  const filteredCampaigns = useTagFilter(campaigns, filter, descendants);

  /**
   * Every control here is server-rendered before React attaches to it, so a
   * click that lands early submits the form natively and silently does
   * nothing. The flag marks the point where the handlers are live; the
   * end-to-end suite waits on it rather than on a timer.
   */
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const act = async (operation: () => Promise<void>, success: string) => {
    setMessage('Working…');
    try {
      await operation();
      setMessage(success);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operation failed');
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void act(
      () => mutate('/api/tags', 'POST', { name, parentId: parentId || null, color: color || null }),
      'Tag created',
    );
  };

  const rename = (tag: UiTag) => {
    const nextName = window.prompt('New tag name', tag.name);
    if (nextName === null || nextName === tag.name) return;
    void act(() => mutate(`/api/tags/${tag.id}`, 'PATCH', { name: nextName }), 'Tag renamed');
  };

  const move = (tag: UiTag) => {
    const nextParent = window.prompt('New parent tag ID (leave blank for root)', tag.parentId ?? '');
    if (nextParent === null) return;
    void act(
      () => mutate(`/api/tags/${tag.id}`, 'PATCH', { parentId: nextParent || null }),
      'Tag moved',
    );
  };

  const remove = (tag: UiTag) => {
    const choice = window.prompt(
      'Type “detach” to remove assignments, or enter the destination tag ID to reassign them',
      'detach',
    );
    if (choice === null || !choice.trim()) return;
    const body = choice === 'detach'
      ? { mode: 'detach' }
      : { mode: 'reassign', targetTagId: choice.trim() };
    void act(() => mutate(`/api/tags/${tag.id}`, 'DELETE', body), 'Tag deleted');
  };

  const bulkFilter = () => ({
    filter: {
      entityType: 'campaign',
      entityIds: filteredCampaigns.map((campaign) => campaign.entityId),
    },
  });

  const bulkAssign = () => {
    if (!bulkTagId) return setMessage('Choose a destination tag first');
    void act(
      () => mutate(`/api/tags/${bulkTagId}/assign`, 'POST', bulkFilter()),
      `Tagged ${filteredCampaigns.length} filtered campaigns`,
    );
  };

  const bulkUnassign = () => {
    if (!bulkTagId) return setMessage('Choose a tag to remove first');
    void act(
      () => mutate(`/api/tags/${bulkTagId}/assign`, 'DELETE', bulkFilter()),
      `Untagged ${filteredCampaigns.length} filtered campaigns`,
    );
  };

  const createGoto = async () => {
    setMessage('Creating link…');
    try {
      const response = await fetch('/api/goto', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: '/tags', state: tagFilterState(filter), label: 'Tag view' }),
      });
      const payload = (await response.json()) as { path?: string; error?: string };
      if (!response.ok || !payload.path) throw new Error(payload.error ?? 'Could not create link');
      setMessage(`Deep link: ${window.location.origin}${payload.path}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create link');
    }
  };

  const renderTree = (nodes: readonly UiTag[], depth = 0) => nodes.map((tag) => (
    <li key={tag.id} style={{ marginLeft: depth * 18, marginBottom: 8 }}>
      <span
        aria-hidden="true"
        style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 10, marginRight: 7, background: tag.color ?? '#94a3b8' }}
      />
      <strong>{tag.name}</strong> <small style={{ color: 'var(--wa-text-faint)' }}>{tag.id}</small>{' '}
      <button type="button" onClick={() => rename(tag)}>Rename</button>{' '}
      <button type="button" onClick={() => move(tag)}>Move</button>{' '}
      <button type="button" onClick={() => remove(tag)}>Delete…</button>
      {tag.children.length > 0 && <ul style={{ listStyle: 'none', padding: 0 }}>{renderTree(tag.children, depth + 1)}</ul>}
    </li>
  ));

  return (
    <main
      className="wa-embed"
      data-interactive={ready ? 'true' : 'false'}
      style={{ maxWidth: 1100, margin: '0 auto', fontFamily: 'var(--wa-font)', color: 'var(--wa-text)' }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Nested tags</h1>
        <p style={{ marginTop: 0, color: 'var(--wa-text-muted)' }}>Classify profiles and advertising entities, then reuse one filter across lists and dashboards.</p>
      </header>
      {message && <p role="status" style={{ padding: 10, background: 'var(--wa-accent-soft)', color: 'var(--wa-accent-text)', borderRadius: 6 }}>{message}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(420px, 2fr)', gap: 20 }}>
        <section style={panel} aria-labelledby="taxonomy-title">
          <h2 id="taxonomy-title">Taxonomy</h2>
          <form onSubmit={create} style={{ display: 'grid', gap: 8, marginBottom: 20 }}>
            <label>Name <input required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Parent{' '}
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">Root</option>
                {allTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
            <label>Color <input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
            <button type="submit">Create tag</button>
          </form>
          {tags.length > 0 ? <ul style={{ listStyle: 'none', padding: 0 }}>{renderTree(tags)}</ul> : <p>No tags yet.</p>}
        </section>
        <section style={panel} aria-labelledby="campaigns-title">
          <h2 id="campaigns-title">Campaign filter demo</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <label>Tag{' '}
              <select
                value={filter.tagIds[0] ?? ''}
                onChange={(event) => setFilter({ ...filter, tagIds: event.target.value ? [event.target.value] : [] })}
              >
                <option value="">All</option>
                {allTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
            <label>Mode{' '}
              <select value={filter.mode} onChange={(event) => setFilter({ ...filter, mode: event.target.value as TagFilter['mode'] })}>
                <option value="any">Has tag</option>
                <option value="none">Does not have tag</option>
                <option value="untagged">Untagged</option>
              </select>
            </label>
            <label><input type="checkbox" checked={filter.includeDescendants !== false} onChange={(event) => setFilter({ ...filter, includeDescendants: event.target.checked })} /> Include child tags</label>
            <button type="button" onClick={() => void createGoto()}>Copyable goto link</button>
          </div>
          <aside aria-label="Dashboard tag summary" style={{ padding: 12, background: 'var(--wa-surface-2)', borderRadius: 8, marginBottom: 14 }}>
            Dashboard count using the same tag filter: <strong>{filteredCampaigns.length}</strong>
          </aside>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <select aria-label="Bulk assignment tag" value={bulkTagId} onChange={(event) => setBulkTagId(event.target.value)}>
              <option value="">Choose destination tag</option>
              {allTags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
            <button type="button" onClick={bulkAssign}>Tag filtered campaigns</button>
            <button type="button" onClick={bulkUnassign}>Remove tag from filtered campaigns</button>
          </div>
          <ul data-testid="campaign-list">
            {filteredCampaigns.map((campaign) => (
              <li key={`${campaign.profileId}:${campaign.entityId}`}>
                {campaign.name ?? campaign.entityId} — {campaign.state} —{' '}
                {campaign.tagIds.map((id) => allTags.find((tag) => tag.id === id)?.name ?? id).join(', ') || 'untagged'}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
