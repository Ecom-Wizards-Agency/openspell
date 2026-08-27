'use client';

/**
 * The experiment list.
 *
 * The profile switcher and the status filter both re-read the server rather than
 * narrowing in the browser, so the list is always the org-scoped query's answer.
 * There are no write controls here beyond the "New experiment" link: status
 * moves and edits live on the detail page, where the whole record is in view.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ExperimentRecord } from '@wizard-ads/db';
import type { ProfileOption } from '../../src/experiments/data';
import { toUiExperiment } from '../../src/experiments/ui';
import type { UiExperiment } from '../../src/experiments/ui';
import { STATUS_LABELS, STATUS_TEXT_COLOR, TYPE_LABELS, METRIC_LABELS, EXPERIMENT_STATUS_OPTIONS } from '../../src/experiments/labels';
import { banner, colors, heading, muted, page } from '../../src/ui/tokens';

const card = {
  border: `1px solid ${colors.border}`,
  borderRadius: '0.5rem',
  marginBottom: '0.75rem',
  padding: '0.875rem 1rem',
} as const;

const day = (iso: string): string => iso.slice(0, 10);

export function ExperimentsList({
  items: initialItems,
  profiles,
  selectedProfileId,
  canManage,
  role,
}: {
  items: UiExperiment[];
  profiles: ProfileOption[];
  selectedProfileId: string | null;
  canManage: boolean;
  role: string;
}) {
  const [items, setItems] = useState(initialItems);
  const [profileId, setProfileId] = useState(selectedProfileId ?? '');
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => setReady(true), []);

  const reload = useCallback(
    async (next: { profile?: string; status?: string }) => {
      const query = new URLSearchParams();
      const wantedProfile = next.profile ?? profileId;
      const wantedStatus = next.status ?? status;
      if (wantedProfile) query.set('profile', wantedProfile);
      if (wantedStatus) query.set('status', wantedStatus);
      const response = await fetch(`/api/experiments?${query.toString()}`);
      const payload = (await response.json().catch(() => null)) as {
        items?: ExperimentRecord[];
        error?: string;
      } | null;
      if (!response.ok || !payload?.items) {
        throw new Error(payload?.error ?? `Could not read experiments (${response.status})`);
      }
      setItems(payload.items.map(toUiExperiment));
    },
    [profileId, status],
  );

  const apply = (next: { profile?: string; status?: string }) => {
    if (next.profile !== undefined) setProfileId(next.profile);
    if (next.status !== undefined) setStatus(next.status);
    setMessage('');
    void reload(next).catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : 'Could not read experiments'),
    );
  };

  const newHref = `/experiments/new${profileId ? `?profile=${profileId}` : ''}`;

  return (
    <main style={page} data-interactive={ready ? 'true' : 'false'}>
      <h1 style={heading}>Experiments</h1>
      <p style={muted}>
        Deliberate tests — bid pushes, new creative, price moves — tracked so their windows shade
        every chart and their outcomes are measurable later. You are signed in as{' '}
        <strong data-testid="experiments-role">{role}</strong>.
      </p>

      {message && (
        <p role="status" style={banner('bad')}>
          {message}
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0', alignItems: 'center' }}>
        <label style={{ fontSize: '0.8125rem' }}>
          Profile{' '}
          <select
            value={profileId}
            data-testid="filter-profile"
            onChange={(event) => apply({ profile: event.target.value })}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} · {profile.countryCode}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: '0.8125rem' }}>
          Status{' '}
          <select
            value={status}
            data-testid="filter-status"
            onChange={(event) => apply({ status: event.target.value })}
          >
            <option value="">All</option>
            {EXPERIMENT_STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {STATUS_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <a href={newHref} data-testid="new-experiment" className="wa-btn wa-btn--primary wa-btn--sm">
            New experiment
          </a>
        )}
      </div>

      <ul data-testid="experiments-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li key={item.id} style={card} data-testid="experiment-item" data-experiment-id={item.id}>
            <div style={{ alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <a href={`/experiments/${item.id}`} style={{ fontSize: '0.9375rem', fontWeight: 600 }}>
                {item.name}
              </a>
              <span
                data-testid="experiment-status"
                style={{ ...muted, color: STATUS_TEXT_COLOR[item.status] }}
              >
                {STATUS_LABELS[item.status]}
              </span>
              <span style={muted} data-testid="experiment-type">
                {TYPE_LABELS[item.type]}
              </span>
              <span style={muted}>focus: {METRIC_LABELS[item.metricFocus]}</span>
            </div>
            <p style={{ ...muted, margin: '0.4rem 0 0' }}>
              {day(item.startAt)} → {item.endAt ? day(item.endAt) : 'running'} · {item.scopeSummary}
            </p>
          </li>
        ))}
      </ul>
      {items.length === 0 && (
        <p data-testid="experiments-empty" style={muted}>
          No experiments for this profile yet. Start one from the grid, or with “New experiment”.
        </p>
      )}
    </main>
  );
}
