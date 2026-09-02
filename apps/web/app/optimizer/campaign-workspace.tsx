'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  OptimizerCampaignRow,
  OptimizerPreviewAccepted,
  OptimizerPreviewBatchStatus,
} from '../../src/optimizer/campaigns';
import {
  filterOptimizerCampaignRows,
  optimizerPreviewError,
  parseOptimizerPreviewAccepted,
  parseOptimizerPreviewStatus,
} from '../../src/optimizer/campaigns';
import {
  OPTIMIZER_PREVIEW_BODY_MAX_BYTES,
  OPTIMIZER_PREVIEW_CAMPAIGN_MAX,
} from '../../src/optimizer/preview-http';

const CAMPAIGNS_PER_PAGE = 25;
const POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const POLL_DEADLINE_MS = 10 * 60 * 1_000;

type ScopeMode = 'all' | 'selected';

interface UncertainPreviewRequest {
  clientRequestId: string;
  scopeKey: string;
}

class UncertainPreviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainPreviewResponseError';
  }
}

class PermanentPreviewStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPreviewStatusError';
  }
}

function gridHref(
  profileId: string,
  period: { start: string; end: string },
  campaignId?: string,
): string {
  const parameters = new URLSearchParams({
    profile: profileId,
    entity: 'campaigns',
    from: period.start,
    to: period.end,
  });
  if (campaignId !== undefined) parameters.set('campaign', campaignId);
  return `/grid?${parameters.toString()}`;
}

function reviewHref(profileId: string, runId: string): string {
  return `/recommendations?${new URLSearchParams({ profile: profileId, run: runId }).toString()}`;
}

export function CampaignWorkspace({
  rows,
  currencyCode,
  profileId,
  period,
  run,
  mayRunOptimizer,
  previewReady,
  initialBatchId,
}: {
  rows: readonly OptimizerCampaignRow[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  run: { id: string; status: string } | null;
  mayRunOptimizer: boolean;
  previewReady: boolean;
  initialBatchId: string | null;
}): ReactNode {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [state, setState] = useState('all');
  const [requestedPage, setRequestedPage] = useState(0);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<ReadonlySet<string>>(new Set());
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<OptimizerPreviewAccepted | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(initialBatchId);
  const [batchStatus, setBatchStatus] = useState<OptimizerPreviewBatchStatus | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deadlineReached, setDeadlineReached] = useState(false);
  const submitController = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const uncertainRequest = useRef<UncertainPreviewRequest | null>(null);
  const previousProfile = useRef(profileId);
  const context = `${profileId}:${period.start}:${period.end}`;
  const previousContext = useRef(context);
  const filtered = useMemo(
    () => filterOptimizerCampaignRows(rows, { query, group, state }),
    [group, query, rows, state],
  );
  const eligibleRows = useMemo(() => rows.filter((row) => row.selectable), [rows]);
  const filteredEligibleRows = useMemo(
    () => filtered.filter((row) => row.selectable),
    [filtered],
  );
  const allFilteredSelected = filteredEligibleRows.length > 0
    && filteredEligibleRows.every((row) => selectedCampaignIds.has(row.campaignId));
  const someFilteredSelected = filteredEligibleRows
    .some((row) => selectedCampaignIds.has(row.campaignId));
  const pageCount = Math.max(1, Math.ceil(filtered.length / CAMPAIGNS_PER_PAGE));
  const page = Math.min(requestedPage, pageCount - 1);
  const pageStart = page * CAMPAIGNS_PER_PAGE;
  const visibleRows = filtered.slice(pageStart, pageStart + CAMPAIGNS_PER_PAGE);
  const groups = useMemo(
    () => [...new Map(rows.flatMap((row) => row.groupId === null || row.groupName === null
      ? []
      : [[row.groupId, row.groupName] as const])).entries()],
    [rows],
  );
  const states = useMemo(() => [...new Set(rows.map((row) => row.state))].sort(), [rows]);
  const assigned = rows.filter((row) => row.groupId !== null).length;
  const withProposals = rows.filter((row) => row.proposals > 0).length;
  const observedStatus = batchStatus?.status ?? accepted?.status ?? null;
  const batchActive = activeBatchId !== null
    && observedStatus !== 'succeeded'
    && observedStatus !== 'failed';
  const allModeTooLarge = eligibleRows.length > OPTIMIZER_PREVIEW_CAMPAIGN_MAX;
  const allModeInvalid = eligibleRows.length === 0 || allModeTooLarge;
  const selectionTooLarge = selectedCampaignIds.size > OPTIMIZER_PREVIEW_CAMPAIGN_MAX;
  const selectedModeInvalid = selectedCampaignIds.size === 0 || selectionTooLarge;
  const runDisabled = !mayRunOptimizer || !previewReady || submitting || batchActive
    || (scopeMode === 'all' ? allModeInvalid : selectedModeInvalid);
  const batchId = activeBatchId;

  useEffect(() => {
    if (previousContext.current !== context) {
      previousContext.current = context;
      setRequestedPage(0);
      return;
    }
    if (requestedPage >= pageCount) setRequestedPage(pageCount - 1);
  }, [context, pageCount, requestedPage]);

  useEffect(() => {
    if (previousProfile.current === profileId) return;
    previousProfile.current = profileId;
    submitController.current?.abort();
    submittingRef.current = false;
    setSelectedCampaignIds(new Set());
    setScopeMode('all');
    setSubmitting(false);
    setAccepted(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setAnnouncement('');
    setError(null);
    setDeadlineReached(false);
    uncertainRequest.current = null;
  }, [profileId]);

  useEffect(() => () => submitController.current?.abort(), []);

  useEffect(() => {
    if (batchId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let stopped = false;
    let delayIndex = 0;
    let observedVisibleMs = 0;
    let visibleStartedAt = document.visibilityState === 'hidden' ? null : Date.now();

    const stopTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const stopDeadlineTimer = (): void => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
    const reachDeadline = (): void => {
      stopped = true;
      stopTimer();
      stopDeadlineTimer();
      controller.abort();
      setDeadlineReached(true);
      setAnnouncement('Still running. Automatic status checks stopped after ten minutes; refresh this page or check Sync status.');
    };
    const remainingObservationMs = (): number => {
      const currentVisibleMs = visibleStartedAt === null ? 0 : Date.now() - visibleStartedAt;
      return POLL_DEADLINE_MS - observedVisibleMs - currentVisibleMs;
    };
    const armDeadline = (): void => {
      if (stopped || controller.signal.aborted || document.visibilityState === 'hidden') return;
      const remaining = remainingObservationMs();
      if (remaining <= 0) {
        reachDeadline();
        return;
      }
      stopDeadlineTimer();
      deadlineTimer = setTimeout(reachDeadline, remaining);
    };
    const schedule = (delay: number): void => {
      if (stopped || controller.signal.aborted || document.visibilityState === 'hidden') return;
      const remaining = remainingObservationMs();
      if (remaining <= 0) {
        reachDeadline();
        return;
      }
      stopTimer();
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, Math.min(delay, remaining));
    };
    const poll = async (): Promise<void> => {
      if (stopped || controller.signal.aborted || polling || document.visibilityState === 'hidden') return;
      if (remainingObservationMs() <= 0) {
        reachDeadline();
        return;
      }
      polling = true;
      try {
        const statusParameters = new URLSearchParams({ profileId });
        const statusPath = ['/api/optimizer/runs', encodeURIComponent(batchId)].join('/');
        const response = await fetch(`${statusPath}?${statusParameters.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const message = optimizerPreviewError(payload, 'Preview status is unavailable.');
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new PermanentPreviewStatusError(message);
          }
          throw new Error(message);
        }
        let next: OptimizerPreviewBatchStatus;
        try {
          next = parseOptimizerPreviewStatus(payload);
        } catch (caught) {
          throw new PermanentPreviewStatusError(
            caught instanceof Error ? caught.message : 'The preview service returned invalid status.',
          );
        }
        if (next.batchId !== batchId) {
          throw new PermanentPreviewStatusError('The preview service returned a mismatched batch.');
        }
        setBatchStatus(next);
        setError(null);
        setAnnouncement(previewAnnouncement(next));
        if (next.status === 'succeeded' || next.status === 'failed') {
          stopped = true;
          stopTimer();
          stopDeadlineTimer();
          router.refresh();
          return;
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof PermanentPreviewStatusError) {
          stopped = true;
          stopTimer();
          stopDeadlineTimer();
          setActiveBatchId(null);
          forgetBatchInUrl();
          setError(caught.message);
          setAnnouncement('Automatic status checks stopped because this preview could not be read.');
          return;
        }
        setAnnouncement('Preview status is temporarily unavailable. Retrying automatically.');
      } finally {
        polling = false;
      }
      delayIndex = Math.min(delayIndex + 1, POLL_DELAYS_MS.length - 1);
      schedule(POLL_DELAYS_MS[delayIndex] as number);
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') {
        if (visibleStartedAt !== null) {
          observedVisibleMs += Date.now() - visibleStartedAt;
          visibleStartedAt = null;
        }
        stopTimer();
        stopDeadlineTimer();
      } else if (!stopped && !polling) {
        visibleStartedAt = Date.now();
        armDeadline();
        schedule(0);
      } else if (visibleStartedAt === null) {
        visibleStartedAt = Date.now();
        armDeadline();
      }
    };

    document.addEventListener('visibilitychange', visibilityChanged);
    armDeadline();
    schedule(POLL_DELAYS_MS[0]);
    return () => {
      stopped = true;
      stopTimer();
      stopDeadlineTimer();
      controller.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [batchId, profileId, router]);

  function toggleCampaign(row: OptimizerCampaignRow): void {
    if (!row.selectable || !mayRunOptimizer || batchActive) return;
    const next = new Set(selectedCampaignIds);
    if (next.has(row.campaignId)) next.delete(row.campaignId);
    else next.add(row.campaignId);
    setSelectedCampaignIds(next);
    setScopeMode('selected');
    setError(null);
  }

  function toggleFilteredCampaigns(): void {
    if (!mayRunOptimizer || batchActive || filteredEligibleRows.length === 0) return;
    const next = new Set(selectedCampaignIds);
    if (allFilteredSelected) {
      for (const row of filteredEligibleRows) next.delete(row.campaignId);
    } else {
      for (const row of filteredEligibleRows) next.add(row.campaignId);
    }
    setSelectedCampaignIds(next);
    setScopeMode('selected');
    setError(null);
  }

  function clearSelection(): void {
    setSelectedCampaignIds(new Set());
    setScopeMode('selected');
    setError(null);
  }

  async function runPreview(): Promise<void> {
    if (runDisabled || submittingRef.current) return;
    const campaignIds = [...selectedCampaignIds].sort();
    const scope = scopeMode === 'all'
      ? { mode: 'all' as const }
      : { mode: 'selected' as const, campaignIds };
    const scopeKey = JSON.stringify({ profileId, scope });
    const priorUncertain = uncertainRequest.current;
    const clientRequestId = priorUncertain?.scopeKey === scopeKey
      ? priorUncertain.clientRequestId
      : globalThis.crypto.randomUUID();
    const body = JSON.stringify({
      profileId,
      clientRequestId,
      scope,
    });
    if (new TextEncoder().encode(body).byteLength > OPTIMIZER_PREVIEW_BODY_MAX_BYTES) {
      setError('The selected preview is too large. Narrow the selection or run all eligible campaigns.');
      return;
    }

    submitController.current?.abort();
    const controller = new AbortController();
    submitController.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setAccepted(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setDeadlineReached(false);
    setAnnouncement('Queueing recommendation preview.');
    setError(null);
    try {
      const result = await postPreview(body, controller.signal);
      if (controller.signal.aborted) return;
      uncertainRequest.current = null;
      setAccepted(result);
      setActiveBatchId(result.batchId);
      rememberBatchInUrl(result.batchId);
      setAnnouncement(`Preview queued for ${result.scope.campaignCount.toLocaleString('en-US')} campaigns across ${result.childCount.toLocaleString('en-US')} ${result.childCount === 1 ? 'run' : 'runs'}.`);
    } catch (caught) {
      if (controller.signal.aborted) return;
      uncertainRequest.current = caught instanceof UncertainPreviewResponseError
        ? { clientRequestId, scopeKey }
        : null;
      setAnnouncement('Recommendation preview was not queued.');
      setError(caught instanceof Error ? caught.message : 'Recommendation preview could not be queued.');
    } finally {
      if (submitController.current === controller) submitController.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="wa-card wa-optimizer-campaigns" aria-labelledby="optimizer-campaigns-title">
      <header className="wa-card__head wa-optimizer-campaigns__head">
        <div>
          <h2 className="wa-card__title" id="optimizer-campaigns-title">Campaigns</h2>
          <p className="wa-card__sub">
            {rows.length} total · {eligibleRows.length} eligible · {assigned} assigned to a group · {withProposals} with a proposed change
          </p>
        </div>
        <div className="wa-row">
          <a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/optimizer/groups?profile=${profileId}`}>
            Manage groups
          </a>
          <a className="wa-btn wa-btn--ghost wa-btn--sm" href={gridHref(profileId, period)}>
            Open full grid →
          </a>
        </div>
      </header>

      <div className="wa-optimizer-campaigns__toolbar" role="search" aria-label="Filter optimizer campaigns">
        <label className="wa-field wa-optimizer-campaigns__search">
          <span className="wa-label">Find campaign</span>
          <input
            aria-label="Find campaign"
            className="wa-input wa-input--sm"
            onChange={(event) => { setQuery(event.target.value); setRequestedPage(0); }}
            placeholder="Name or campaign ID"
            type="search"
            value={query}
          />
        </label>
        <label className="wa-field">
          <span className="wa-label">Optimization group</span>
          <select className="wa-select wa-select--sm" onChange={(event) => { setGroup(event.target.value); setRequestedPage(0); }} value={group}>
            <option value="all">All groups</option>
            <option value="unassigned">Unassigned</option>
            {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="wa-field">
          <span className="wa-label">Campaign state</span>
          <select className="wa-select wa-select--sm" onChange={(event) => { setState(event.target.value); setRequestedPage(0); }} value={state}>
            <option value="all">All states</option>
            {states.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <span className="wa-optimizer-campaigns__shown" aria-live="polite">
          {filtered.length === 0
            ? '0 campaigns'
            : `${pageStart + 1}–${pageStart + visibleRows.length} of ${filtered.length}`}
        </span>
        {query === '' && group === 'all' && state === 'all' ? null : (
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            onClick={() => { setQuery(''); setGroup('all'); setState('all'); setRequestedPage(0); }}
            type="button"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="wa-optimizer-preview" aria-busy={batchActive}>
        <fieldset className="wa-optimizer-preview__scope" aria-busy={batchActive}>
          <legend>Preview scope</legend>
          <label>
            <input
              checked={scopeMode === 'all'}
              className="wa-checkbox"
              disabled={!mayRunOptimizer || batchActive || allModeInvalid}
              name="optimizer-preview-scope"
              onChange={() => { setScopeMode('all'); setError(null); }}
              type="radio"
            />
            <span>All eligible campaigns ({eligibleRows.length.toLocaleString('en-US')})</span>
          </label>
          <label>
            <input
              checked={scopeMode === 'selected'}
              className="wa-checkbox"
              disabled={!mayRunOptimizer || batchActive || selectedCampaignIds.size === 0}
              name="optimizer-preview-scope"
              onChange={() => { setScopeMode('selected'); setError(null); }}
              type="radio"
            />
            <span>Selected campaigns ({selectedCampaignIds.size.toLocaleString('en-US')})</span>
          </label>
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            disabled={selectedCampaignIds.size === 0 || batchActive}
            onClick={clearSelection}
            type="button"
          >
            Clear selected
          </button>
        </fieldset>
        <div className="wa-optimizer-preview__action">
          <button
            aria-busy={submitting || batchActive}
            className="wa-btn wa-btn--primary wa-btn--sm"
            data-testid="optimizer-run-preview"
            disabled={runDisabled}
            onClick={() => void runPreview()}
            type="button"
          >
            {submitting
              ? 'Queueing preview…'
              : scopeMode === 'all'
                ? `Run preview · all ${eligibleRows.length.toLocaleString('en-US')}`
                : `Run preview · ${selectedCampaignIds.size.toLocaleString('en-US')} selected`}
          </button>
          <span className="wa-hint">Read-only preview · Amazon is not updated</span>
        </div>
        <p className="wa-optimizer-preview__selection" data-testid="optimizer-selection-count" aria-live="polite">
          {selectedCampaignIds.size === 0
            ? 'No campaigns selected.'
            : `${selectedCampaignIds.size.toLocaleString('en-US')} ${selectedCampaignIds.size === 1 ? 'campaign' : 'campaigns'} selected. Selections outside the current page or filters remain selected.`}
        </p>
        {!mayRunOptimizer ? (
          <p className="wa-optimizer-preview__permission">Your role can view previews but cannot queue one.</p>
        ) : !previewReady ? (
          <p className="wa-optimizer-preview__permission" role="status">
            Recommendation previews are temporarily unavailable.
          </p>
        ) : allModeTooLarge ? (
          <p className="wa-optimizer-preview__error" role="alert">
            One preview supports at most {OPTIMIZER_PREVIEW_CAMPAIGN_MAX.toLocaleString('en-US')} campaigns. Select a smaller campaign set.
          </p>
        ) : selectionTooLarge ? (
          <p className="wa-optimizer-preview__error" role="alert">
            Selected previews support at most {OPTIMIZER_PREVIEW_CAMPAIGN_MAX.toLocaleString('en-US')} campaigns. Narrow the selection.
          </p>
        ) : null}
        {error === null ? null : <p className="wa-optimizer-preview__error" role="alert">{error}</p>}
        <div className="wa-optimizer-preview__status" aria-live="polite" aria-atomic="true">
          {announcement}
          {deadlineReached ? <span> The preview may still complete in the background.</span> : null}
        </div>
        {batchStatus === null ? null : (
          <PreviewChildren profileId={profileId} status={batchStatus} />
        )}
      </div>

      {run?.status === 'succeeded' && withProposals === 0 ? (
        <div className="wa-optimizer-campaigns__run-note" role="status">
          <span aria-hidden="true">✓</span>
          <span><strong>No changes recommended in this run.</strong> Campaign performance remains available below.</span>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="wa-optimizer-campaigns__empty">
          <strong>No campaigns match these filters.</strong>
          <button className="wa-btn wa-btn--ghost wa-btn--sm" onClick={() => { setQuery(''); setGroup('all'); setState('all'); setRequestedPage(0); }} type="button">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="wa-tablewrap wa-optimizer-campaigns__tablewrap">
          <table className="wa-table wa-table--dense wa-table--numeric" aria-busy={batchActive}>
            <thead>
              <tr>
                <th scope="col" className="wa-optimizer-campaigns__select">
                  <input
                    aria-label={`${allFilteredSelected ? 'Deselect' : 'Select'} all ${filteredEligibleRows.length.toLocaleString('en-US')} eligible campaigns matching current filters`}
                    checked={allFilteredSelected}
                    className="wa-checkbox"
                    data-testid="optimizer-select-filtered"
                    disabled={!mayRunOptimizer || batchActive || filteredEligibleRows.length === 0}
                    onChange={toggleFilteredCampaigns}
                    ref={(element) => {
                      if (element !== null) element.indeterminate = !allFilteredSelected && someFilteredSelected;
                    }}
                    type="checkbox"
                  />
                </th>
                <th scope="col">Campaign</th>
                <th scope="col">Group</th>
                <th scope="col">State</th>
                <th scope="col">Ad product</th>
                <th scope="col">Spend</th>
                <th scope="col">Ad sales</th>
                <th scope="col">ACOS</th>
                <th scope="col">Orders</th>
                <th scope="col">Daily budget</th>
                <th scope="col">Last group run</th>
                <th scope="col">Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const reasonId = `optimizer-campaign-${row.campaignId}-eligibility`;
                return (
                  <tr key={row.campaignId}>
                    <td className="wa-optimizer-campaigns__select">
                      <input
                        aria-describedby={row.eligibilityReason === null ? undefined : reasonId}
                        aria-label={`Select ${row.name} for this preview`}
                        checked={selectedCampaignIds.has(row.campaignId)}
                        className="wa-checkbox"
                        data-testid="optimizer-campaign-select"
                        disabled={!mayRunOptimizer || batchActive || !row.selectable}
                        onChange={() => toggleCampaign(row)}
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <a
                        className="wa-optimizer-campaigns__name"
                        href={gridHref(profileId, period, row.campaignId)}
                      >
                        {row.name}
                      </a>
                      <span className="wa-optimizer-campaigns__sub">
                        {row.biddingStrategy === null ? 'Bid strategy unavailable' : titleCase(row.biddingStrategy)}
                        {row.startDate === null ? '' : ` · started ${row.startDate}`}
                      </span>
                      {row.eligibilityReason === null ? null : (
                        <span className="wa-optimizer-campaigns__ineligible" id={reasonId}>
                          {row.eligibilityReason}
                        </span>
                      )}
                    </td>
                    <td>
                      {row.groupName === null ? (
                        <span className="wa-hint">Unassigned</span>
                      ) : (
                        <span className={`wa-cat wa-cat--${row.groupRole ?? 'unknown'}`}>{row.groupName}</span>
                      )}
                    </td>
                    <td><span className="wa-badge">{titleCase(row.state)}</span></td>
                    <td>{row.adProduct}</td>
                    <td>
                      {row.currentRows === 0 ? <span className="wa-hint">No activity</span> : money(row.spend, currencyCode)}
                      {row.currentRows === 0 ? null : <SpendDelta current={row.spend} prior={row.comparisonRows === 0 ? null : row.comparisonSpend} />}
                    </td>
                    <td>{row.currentRows === 0 ? '—' : money(row.sales, currencyCode)}</td>
                    <td>{row.currentRows === 0 || row.sales === 0 ? '—' : `${((row.spend / row.sales) * 100).toFixed(1)}%`}</td>
                    <td>{row.currentRows === 0 ? '—' : row.orders.toLocaleString('en-US')}</td>
                    <td>{row.dailyBudget === null ? '—' : money(row.dailyBudget, currencyCode)}</td>
                    <td>{row.lastRunAt === null ? 'Never' : shortDate(row.lastRunAt)}</td>
                    <td>
                      {row.proposals > 0 && run !== null ? (
                        <a className="wa-badge wa-badge--warn" href={reviewHref(profileId, run.id)}>
                          {row.proposals} to review
                        </a>
                      ) : (
                        <span className="wa-hint">{recommendationState(run)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {pageCount > 1 ? (
            <nav className="wa-optimizer-campaigns__pagination" aria-label="Campaign pages">
              <span>Page {page + 1} of {pageCount}</span>
              <div className="wa-row">
                <button
                  className="wa-btn wa-btn--ghost wa-btn--sm"
                  disabled={page === 0}
                  onClick={() => setRequestedPage(Math.max(0, page - 1))}
                  type="button"
                >
                  ← Previous
                </button>
                <button
                  className="wa-btn wa-btn--ghost wa-btn--sm"
                  disabled={page >= pageCount - 1}
                  onClick={() => setRequestedPage(Math.min(pageCount - 1, page + 1))}
                  type="button"
                >
                  Next →
                </button>
              </div>
            </nav>
          ) : null}
        </div>
      )}
    </section>
  );
}

async function postPreview(body: string, signal: AbortSignal): Promise<OptimizerPreviewAccepted> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch('/api/optimizer/runs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 1) {
        throw new UncertainPreviewResponseError('The preview response was interrupted. Retry to check the same request safely.');
      }
      continue;
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      if (response.status >= 500 && attempt === 0) continue;
      if (response.status >= 500) {
        throw new UncertainPreviewResponseError(
          optimizerPreviewError(payload, 'The preview service did not confirm whether the request was queued. Retry safely.'),
        );
      }
      throw new Error(optimizerPreviewError(payload, 'Recommendation preview could not be queued.'));
    }
    try {
      return parseOptimizerPreviewAccepted(payload);
    } catch (error) {
      throw new UncertainPreviewResponseError(
        error instanceof Error ? error.message : 'The preview service returned an invalid acceptance response.',
      );
    }
  }
  throw new Error('Recommendation preview could not be queued.');
}

function rememberBatchInUrl(batchId: string): void {
  const parameters = new URLSearchParams(window.location.search);
  parameters.set('batch', batchId);
  const query = parameters.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
}

function forgetBatchInUrl(): void {
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete('batch');
  const query = parameters.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
}

function PreviewChildren({
  profileId,
  status,
}: {
  profileId: string;
  status: OptimizerPreviewBatchStatus;
}): ReactNode {
  if (status.children.length === 0) return null;
  return (
    <ul className="wa-optimizer-preview__children" aria-label="Preview runs">
      {status.children.map((child) => (
        <li key={child.runId}>
          <span>{child.groupName ?? 'Unassigned campaigns'} · {child.campaignCount.toLocaleString('en-US')} campaigns · {titleCase(child.status)}</span>
          {child.status === 'succeeded' ? (
            <a href={reviewHref(profileId, child.runId)}>
              Review {child.proposalsCount.toLocaleString('en-US')} {child.proposalsCount === 1 ? 'recommendation' : 'recommendations'} →
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function previewAnnouncement(status: OptimizerPreviewBatchStatus): string {
  if (status.status === 'queued') {
    return `Preview queued for ${status.campaignCount.toLocaleString('en-US')} campaigns.`;
  }
  if (status.status === 'running') {
    return `Preview running for ${status.campaignCount.toLocaleString('en-US')} campaigns.`;
  }
  if (status.status === 'failed') {
    return `Preview failed. ${status.proposalsCount.toLocaleString('en-US')} ${status.proposalsCount === 1 ? 'recommendation remains' : 'recommendations remain'} available from completed runs.`;
  }
  return status.proposalsCount === 0
    ? 'Preview completed. No changes were recommended.'
    : `Preview completed with ${status.proposalsCount.toLocaleString('en-US')} ${status.proposalsCount === 1 ? 'recommendation' : 'recommendations'} to review.`;
}

function SpendDelta({ current, prior }: { current: number; prior: number | null }): ReactNode {
  if (prior === null || prior === 0) return <span className="wa-optimizer-campaigns__sub">No comparison</span>;
  const delta = (current - prior) / prior;
  return <span className="wa-optimizer-campaigns__sub">{delta >= 0 ? '↑' : '↓'} {Math.abs(delta * 100).toFixed(1)}%</span>;
}

function recommendationState(run: { status: string } | null): string {
  if (run === null) return 'Not run';
  if (run.status === 'queued' || run.status === 'running') return 'Pending';
  if (run.status === 'failed') return 'Run failed';
  return 'No change';
}

function money(value: number, currencyCode: string): string {
  return value.toLocaleString('en-US', {
    currency: currencyCode,
    maximumFractionDigits: value >= 100 ? 0 : 2,
    style: 'currency',
  });
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(value));
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
