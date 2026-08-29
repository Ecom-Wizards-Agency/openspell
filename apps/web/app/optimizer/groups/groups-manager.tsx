'use client';

import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  OptimizationCampaignChoice,
  OptimizationGroupRecord,
  OptimizationWorkspace,
} from '@wizard-ads/db';
import {
  OptimizationWeekday,
  type OptimizationWeekday as OptimizationWeekdayValue,
} from '@wizard-ads/shared';

interface GroupDraft {
  id: string | null;
  name: string;
  role: '' | 'rank' | 'discovery' | 'profit' | 'shield';
  targetAcosPercent: string;
  bidFloor: string;
  bidCeiling: string;
  bidIncreaseCapPercent: string;
  bidDecreaseCapPercent: string;
  placementIncreaseCapPercent: string;
  placementDecreaseCapPercent: string;
  reviewWeekdays: OptimizationWeekdayValue[];
  reviewLocalTime: string;
  prioritization: '' | 'efficiency_first' | 'growth_first' | 'balanced';
  exclusions: string;
  enabled: boolean;
  campaignIds: string[];
}

const EMPTY: GroupDraft = {
  id: null,
  name: '',
  role: '',
  targetAcosPercent: '',
  bidFloor: '',
  bidCeiling: '',
  bidIncreaseCapPercent: '',
  bidDecreaseCapPercent: '',
  placementIncreaseCapPercent: '',
  placementDecreaseCapPercent: '',
  reviewWeekdays: ['monday'],
  reviewLocalTime: '09:00',
  prioritization: '',
  exclusions: '',
  enabled: false,
  campaignIds: [],
};

const ROLE_LABELS: Record<Exclude<GroupDraft['role'], ''>, string> = {
  rank: 'Rank',
  discovery: 'Discovery',
  profit: 'Profit',
  shield: 'Shield',
};

const WEEKDAY_LABELS: Readonly<Record<OptimizationWeekdayValue, string>> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
};

export function OptimizationGroupsManager({
  profileId,
  initial,
  canManage,
}: {
  profileId: string;
  initial: OptimizationWorkspace;
  canManage: boolean;
}): ReactNode {
  const [workspace, setWorkspace] = useState(initial);
  const [draft, setDraft] = useState<GroupDraft>(() =>
    initial.groups[0] ? draftFromRecord(initial.groups[0]) : EMPTY,
  );
  const [campaignQuery, setCampaignQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleCampaigns = useMemo(() => {
    const query = campaignQuery.trim().toLowerCase();
    if (!query) return workspace.campaigns;
    return workspace.campaigns.filter((campaign) =>
      `${campaign.name} ${campaign.campaignId} ${campaign.adProduct}`.toLowerCase().includes(query),
    );
  }, [campaignQuery, workspace.campaigns]);
  const selectedVisibleCampaigns = visibleCampaigns.filter((campaign) =>
    draft.campaignIds.includes(campaign.campaignId),
  ).length;
  const allVisibleCampaignsSelected = visibleCampaigns.length > 0
    && selectedVisibleCampaigns === visibleCampaigns.length;

  const selectedRecord = draft.id === null
    ? null
    : workspace.groups.find((record) => record.group.id === draft.id) ?? null;

  function select(record: OptimizationGroupRecord): void {
    setDraft(draftFromRecord(record));
    setCampaignQuery('');
    setMessage(null);
    setError(null);
  }

  function createNew(): void {
    setDraft(EMPTY);
    setCampaignQuery('');
    setMessage(null);
    setError(null);
  }

  function patch<K extends keyof GroupDraft>(key: K, value: GroupDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleCampaign(campaignId: string): void {
    setDraft((current) => ({
      ...current,
      campaignIds: current.campaignIds.includes(campaignId)
        ? current.campaignIds.filter((id) => id !== campaignId)
        : [...current.campaignIds, campaignId],
    }));
  }

  function toggleWeekday(weekday: OptimizationWeekdayValue): void {
    setDraft((current) => {
      const selected = current.reviewWeekdays.includes(weekday);
      if (selected && current.reviewWeekdays.length === 1) return current;
      const weekdays = selected
        ? current.reviewWeekdays.filter((candidate) => candidate !== weekday)
        : [...current.reviewWeekdays, weekday];
      return {
        ...current,
        reviewWeekdays: OptimizationWeekday.options.filter((candidate) => weekdays.includes(candidate)),
      };
    });
  }

  function toggleVisibleCampaigns(): void {
    const visibleIds = new Set(visibleCampaigns.map((campaign) => campaign.campaignId));
    setDraft((current) => ({
      ...current,
      campaignIds: allVisibleCampaignsSelected
        ? current.campaignIds.filter((campaignId) => !visibleIds.has(campaignId))
        : Array.from(new Set([...current.campaignIds, ...visibleIds])),
    }));
  }

  async function refresh(preferredId: string): Promise<void> {
    const response = await fetch(`/api/optimizer/groups?profileId=${encodeURIComponent(profileId)}`);
    const body = await response.json() as OptimizationWorkspace & { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'Could not reload optimization groups');
    setWorkspace(body);
    const selected = body.groups.find((record) => record.group.id === preferredId);
    if (selected) setDraft(draftFromRecord(selected));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/optimizer/groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: draft.id,
          profileId,
          name: draft.name,
          role: draft.role,
          targetAcosPercent: draft.targetAcosPercent,
          bidFloor: draft.bidFloor,
          bidCeiling: draft.bidCeiling,
          bidIncreaseCapPercent: draft.bidIncreaseCapPercent,
          bidDecreaseCapPercent: draft.bidDecreaseCapPercent,
          placementIncreaseCapPercent: draft.placementIncreaseCapPercent,
          placementDecreaseCapPercent: draft.placementDecreaseCapPercent,
          reviewWeekdays: draft.reviewWeekdays,
          reviewLocalTime: draft.reviewLocalTime,
          prioritization: draft.prioritization,
          exclusions: draft.exclusions.split('\n').map((value) => value.trim()).filter(Boolean),
          enabled: draft.enabled,
          campaignIds: draft.campaignIds,
        }),
      });
      const body = await response.json() as {
        error?: string;
        record?: OptimizationGroupRecord;
        assignedCampaigns?: number;
        movedCampaigns?: number;
        removedCampaigns?: number;
      };
      if (!response.ok || !body.record) throw new Error(body.error ?? 'Could not save group');
      await refresh(body.record.group.id);
      setMessage(
        `Saved ${body.assignedCampaigns ?? 0} campaign assignments` +
          `${body.movedCampaigns ? ` · moved ${body.movedCampaigns} from another group` : ''}` +
          `${body.removedCampaigns ? ` · removed ${body.removedCampaigns}` : ''}.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save group');
    } finally {
      setPending(false);
    }
  }

  async function runNow(): Promise<void> {
    if (draft.id === null) return;
    setPending(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/optimizer/groups/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profileId, groupId: draft.id }),
      });
      const body = await response.json() as { error?: string; runId?: string };
      if (!response.ok || !body.runId) throw new Error(body.error ?? 'Could not queue preview');
      await refresh(draft.id);
      setMessage('Preview queued. OpenSpell will evaluate this group only; Amazon is unchanged.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue preview');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="wa-stack" data-testid="optimization-groups-manager">
      <section className="wa-kpi-strip" aria-label="Optimization group coverage">
        <Summary value={workspace.groups.length} label="Groups" />
        <Summary value={workspace.assignedCampaigns} label="Assigned" />
        <Summary value={workspace.unassignedCampaigns} label="Unassigned" warn={workspace.unassignedCampaigns > 0} />
        <Summary
          value={workspace.groups.filter((record) => record.group.enabled).length}
          label="Scheduled"
        />
      </section>

      <div className="wa-opt-groups-layout">
        <aside className="wa-card wa-opt-groups-list" aria-label="Optimization groups">
          <div className="wa-section-head">
            <div>
              <span className="wa-eyebrow">Policy pools</span>
              <h2 className="wa-section-title">Optimization groups</h2>
            </div>
            {canManage ? (
              <button type="button" className="wa-btn wa-btn--sm" onClick={createNew}>
                New group
              </button>
            ) : null}
          </div>
          <div className="wa-opt-groups-list__items">
            {workspace.groups.length === 0 ? (
              <p className="wa-hint">No groups yet. Create the first policy pool and assign campaigns.</p>
            ) : workspace.groups.map((record) => (
              <button
                key={record.group.id}
                type="button"
                className="wa-opt-group-item"
                aria-current={draft.id === record.group.id ? 'true' : undefined}
                onClick={() => select(record)}
              >
                <span className="wa-opt-group-item__top">
                  <strong>{record.group.name}</strong>
                  <span className={`wa-badge ${record.group.enabled ? 'wa-badge--info' : ''}`}>
                    {record.group.enabled ? 'Scheduled' : 'Schedule off'}
                  </span>
                </span>
                <span className="wa-opt-group-item__meta">
                  {ROLE_LABELS[record.group.role]} · {record.campaignIds.length} campaign{record.campaignIds.length === 1 ? '' : 's'}
                </span>
                <span className="wa-opt-group-item__meta">
                  Target ACOS {(record.group.targetAcos * 100).toFixed(1)}% · {scheduleLabel(record)}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <form className="wa-card wa-opt-group-editor" onSubmit={save}>
          <div className="wa-section-head">
            <div>
              <span className="wa-eyebrow">{draft.id === null ? 'New policy pool' : 'Saved policy pool'}</span>
              <h2 className="wa-section-title">{draft.name || 'Untitled group'}</h2>
            </div>
            {selectedRecord?.lastRun ? (
              <span className="wa-badge">
                Last run {selectedRecord.lastRun.status} · {selectedRecord.lastRun.proposalsCount} proposals
              </span>
            ) : null}
          </div>

          <div className="wa-form-grid wa-form-grid--3">
            <Field label="Group name">
              <input value={draft.name} onChange={(event) => patch('name', event.target.value)} required disabled={!canManage} />
            </Field>
            <Field label="Role">
              <select value={draft.role} onChange={(event) => patch('role', event.target.value as GroupDraft['role'])} required disabled={!canManage}>
                <option value="">Choose role</option>
                <option value="rank">Rank</option>
                <option value="discovery">Discovery</option>
                <option value="profit">Profit</option>
                <option value="shield">Shield</option>
              </select>
            </Field>
            <Field label="Prioritization">
              <select value={draft.prioritization} onChange={(event) => patch('prioritization', event.target.value as GroupDraft['prioritization'])} required disabled={!canManage}>
                <option value="">Choose mode</option>
                <option value="efficiency_first">Efficiency first</option>
                <option value="growth_first">Growth first</option>
                <option value="balanced">Balanced</option>
              </select>
            </Field>
            <Field label="Target ACOS" suffix="%">
              <input type="number" min="0" step="0.1" value={draft.targetAcosPercent} onChange={(event) => patch('targetAcosPercent', event.target.value)} required disabled={!canManage} />
            </Field>
          </div>

          <div className="wa-review-schedule" data-testid="optimization-review-schedule">
            <div className="wa-section-head">
              <div>
                <h3 className="wa-subsection-title">Review schedule</h3>
                <p className="wa-hint">Choose when this group becomes due for a new recommendation preview.</p>
              </div>
              <span className="wa-badge" data-testid="review-timezone">
                {workspace.profileTimezone ?? 'Timezone unavailable'}
              </span>
            </div>
            {selectedRecord?.group.scheduleMigrationState === 'needs_review' ? (
              <p className="wa-notice wa-notice--warn" role="status">
                This legacy interval could not be converted without changing its frequency. Review the days and time before enabling scheduled previews.
              </p>
            ) : selectedRecord?.group.scheduleMigrationState === 'legacy_supported' ? (
              <p className="wa-notice" role="status">
                This schedule was safely translated from the previous interval. Saving confirms the weekday schedule.
              </p>
            ) : null}
            <fieldset className="wa-weekday-fieldset" disabled={!canManage}>
              <legend>Review days</legend>
              <div className="wa-weekday-chips">
                {OptimizationWeekday.options.map((weekday) => {
                  const checked = draft.reviewWeekdays.includes(weekday);
                  return (
                    <label className="wa-weekday-chip" data-selected={checked ? 'true' : 'false'} key={weekday}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManage || (checked && draft.reviewWeekdays.length === 1)}
                        onChange={() => toggleWeekday(weekday)}
                      />
                      <span>{WEEKDAY_LABELS[weekday]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="wa-review-schedule__controls">
              <Field label="Local review time" info={`This time is interpreted in ${workspace.profileTimezone ?? 'the profile timezone'}.`}>
                <input
                  type="time"
                  value={draft.reviewLocalTime}
                  onChange={(event) => patch('reviewLocalTime', event.target.value)}
                  required
                  disabled={!canManage}
                />
              </Field>
              <label className="wa-check-field">
                <input type="checkbox" checked={draft.enabled} onChange={(event) => patch('enabled', event.target.checked)} disabled={!canManage} />
                <span><strong>Scheduled previews</strong><small>Run this group automatically on its selected local days.</small></span>
              </label>
              {selectedRecord?.nextReviewAt ? (
                <p className="wa-hint">Next review: {formatNextReview(selectedRecord.nextReviewAt, workspace.profileTimezone)}</p>
              ) : (
                <p className="wa-hint">No scheduled preview is currently due.</p>
              )}
            </div>
            <p className="wa-schedule-boundary">
              Review schedules create previews only. Sending unattended changes to Amazon requires a separate, explicitly enabled apply cadence with its own approval and kill switch.
            </p>
          </div>

          <div className="wa-divider" />
          <h3 className="wa-subsection-title">Bid guardrails</h3>
          <p className="wa-hint">Caps are ceilings, not fixed steps. Values come from this tenant’s strategy—not application defaults.</p>
          <div className="wa-form-grid wa-form-grid--3">
            <Field label="Bid floor" optional><input type="number" min="0" step="0.01" value={draft.bidFloor} onChange={(event) => patch('bidFloor', event.target.value)} disabled={!canManage} /></Field>
            <Field label="Bid ceiling" optional><input type="number" min="0" step="0.01" value={draft.bidCeiling} onChange={(event) => patch('bidCeiling', event.target.value)} disabled={!canManage} /></Field>
            <span />
            <Field label="Bid increase cap" suffix="%"><input type="number" min="0" step="0.1" value={draft.bidIncreaseCapPercent} onChange={(event) => patch('bidIncreaseCapPercent', event.target.value)} required disabled={!canManage} /></Field>
            <Field label="Bid decrease cap" suffix="%"><input type="number" min="0" step="0.1" value={draft.bidDecreaseCapPercent} onChange={(event) => patch('bidDecreaseCapPercent', event.target.value)} required disabled={!canManage} /></Field>
            <span />
            <Field label="Placement increase cap" suffix="%"><input type="number" min="0" step="0.1" value={draft.placementIncreaseCapPercent} onChange={(event) => patch('placementIncreaseCapPercent', event.target.value)} required disabled={!canManage} /></Field>
            <Field label="Placement decrease cap" suffix="%"><input type="number" min="0" step="0.1" value={draft.placementDecreaseCapPercent} onChange={(event) => patch('placementDecreaseCapPercent', event.target.value)} required disabled={!canManage} /></Field>
          </div>

          <div className="wa-divider" />
          <div className="wa-section-head">
            <div>
              <h3 className="wa-subsection-title">Campaign assignments</h3>
              <p className="wa-hint">Each campaign belongs to exactly one group. Selecting an assigned campaign moves it on save.</p>
            </div>
            <span className="wa-badge wa-badge--info">{draft.campaignIds.length} selected</span>
          </div>
          <input
            aria-label="Search campaigns"
            placeholder="Search campaign name or ID"
            value={campaignQuery}
            onChange={(event) => setCampaignQuery(event.target.value)}
          />
          <div className="wa-campaign-picker-toolbar">
            <span className="wa-hint">
              {visibleCampaigns.length} shown · {selectedVisibleCampaigns} selected in this view
            </span>
            <span
              aria-label="Select all applies only to campaigns matching the current search filter."
              className="wa-info-mark"
              role="img"
              tabIndex={0}
              title="Select all applies only to campaigns matching the current search filter. Selections outside the filter stay unchanged."
            >
              i
            </span>
            <button
              aria-label={allVisibleCampaignsSelected
                ? 'Deselect all campaigns matching the current filter'
                : 'Select all campaigns matching the current filter'}
              className="wa-btn wa-btn--ghost wa-btn--sm"
              disabled={!canManage || visibleCampaigns.length === 0}
              onClick={toggleVisibleCampaigns}
              type="button"
            >
              {allVisibleCampaignsSelected ? 'Deselect all' : 'Select all'}
            </button>
          </div>
          <div className="wa-campaign-picker">
            {visibleCampaigns.map((campaign) => (
              <CampaignChoice
                key={campaign.campaignId}
                campaign={campaign}
                checked={draft.campaignIds.includes(campaign.campaignId)}
                currentGroupId={draft.id}
                disabled={!canManage}
                onChange={() => toggleCampaign(campaign.campaignId)}
              />
            ))}
            {visibleCampaigns.length === 0 ? <p className="wa-hint">No campaigns match this search.</p> : null}
          </div>

          <Field
            label="Exclusion notes"
            optional
            hint="Reference metadata only. These notes do not suppress recommendations until typed exclusion rules are available."
          >
            <textarea rows={3} value={draft.exclusions} onChange={(event) => patch('exclusions', event.target.value)} disabled={!canManage} />
          </Field>

          {error ? <p role="alert" className="wa-notice wa-notice--error">{error}</p> : null}
          {message ? <p role="status" className="wa-notice">{message}</p> : null}

          <div className="wa-editor-actions">
            <p className="wa-hint">Run now remains available when scheduled previews are off. Neither action updates Amazon.</p>
            <div className="wa-row">
              {draft.id !== null ? (
                <button
                  type="button"
                  className="wa-btn"
                  onClick={runNow}
                  disabled={!canManage || pending || draft.campaignIds.length === 0}
                >
                  Run preview now
                </button>
              ) : null}
              <button type="submit" className="wa-btn wa-btn--primary" disabled={!canManage || pending}>
                {pending ? 'Working…' : 'Save group'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function Summary({ value, label, warn = false }: { value: number; label: string; warn?: boolean }): ReactNode {
  return <div className={`wa-kpi-mini ${warn ? 'wa-kpi-mini--warn' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}

function Field({
  label,
  suffix,
  optional = false,
  hint,
  info,
  children,
}: {
  label: string;
  suffix?: string;
  optional?: boolean;
  hint?: string;
  info?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="wa-field">
      <span>
        {label}
        {info ? (
          <span aria-label={info} className="wa-info-mark" role="img" tabIndex={0} title={info}>i</span>
        ) : null}
        {optional ? <small>Optional</small> : null}
      </span>
      <span className="wa-input-suffix">{children}{suffix ? <b>{suffix}</b> : null}</span>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function CampaignChoice({
  campaign,
  checked,
  currentGroupId,
  disabled,
  onChange,
}: {
  campaign: OptimizationCampaignChoice;
  checked: boolean;
  currentGroupId: string | null;
  disabled: boolean;
  onChange: () => void;
}): ReactNode {
  const moves = checked && campaign.groupId !== null && campaign.groupId !== currentGroupId;
  return (
    <label className="wa-campaign-choice">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span>
        <strong>{campaign.name}</strong>
        <small>{campaign.adProduct} · {campaign.state} · {campaign.campaignId}</small>
      </span>
      {moves ? <span className="wa-badge">Moves here</span> : null}
    </label>
  );
}

function draftFromRecord(record: OptimizationGroupRecord): GroupDraft {
  const reviewSchedule = record.group.reviewSchedule ?? {
    weekdays: ['monday'] as OptimizationWeekdayValue[],
    localTime: '09:00',
  };
  return {
    id: record.group.id,
    name: record.group.name,
    role: record.group.role,
    targetAcosPercent: decimal(record.group.targetAcos * 100),
    bidFloor: nullableDecimal(record.group.bidFloor),
    bidCeiling: nullableDecimal(record.group.bidCeiling),
    bidIncreaseCapPercent: decimal(record.group.bidIncreaseCap * 100),
    bidDecreaseCapPercent: decimal(record.group.bidDecreaseCap * 100),
    placementIncreaseCapPercent: decimal(record.group.placementIncreaseCap * 100),
    placementDecreaseCapPercent: decimal(record.group.placementDecreaseCap * 100),
    reviewWeekdays: [...reviewSchedule.weekdays],
    reviewLocalTime: reviewSchedule.localTime,
    prioritization: record.group.prioritization,
    exclusions: record.group.exclusions.join('\n'),
    enabled: record.group.enabled,
    campaignIds: record.campaignIds,
  };
}

function scheduleLabel(record: OptimizationGroupRecord): string {
  const schedule = record.group.reviewSchedule;
  if (schedule === null) return 'Schedule needs review';
  const days = schedule.weekdays.map((weekday) => WEEKDAY_LABELS[weekday]).join(', ');
  return `${days} at ${schedule.localTime}`;
}

function formatNextReview(value: string, timeZone: string | null): string {
  if (timeZone === null) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function decimal(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function nullableDecimal(value: number | null): string {
  return value === null ? '' : decimal(value);
}
