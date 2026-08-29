'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { OptimizerCampaignRow } from '../../src/optimizer/campaigns';
import { filterOptimizerCampaignRows } from '../../src/optimizer/campaigns';

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

export function CampaignWorkspace({
  rows,
  currencyCode,
  profileId,
  period,
  run,
}: {
  rows: readonly OptimizerCampaignRow[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  run: { id: string; status: string } | null;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [state, setState] = useState('all');
  const filtered = useMemo(
    () => filterOptimizerCampaignRows(rows, { query, group, state }),
    [group, query, rows, state],
  );
  const groups = useMemo(
    () => [...new Map(rows.flatMap((row) => row.groupId === null || row.groupName === null
      ? []
      : [[row.groupId, row.groupName] as const])).entries()],
    [rows],
  );
  const states = useMemo(() => [...new Set(rows.map((row) => row.state))].sort(), [rows]);
  const assigned = rows.filter((row) => row.groupId !== null).length;
  const withProposals = rows.filter((row) => row.proposals > 0).length;

  return (
    <section className="wa-card wa-optimizer-campaigns" aria-labelledby="optimizer-campaigns-title">
      <header className="wa-card__head wa-optimizer-campaigns__head">
        <div>
          <h2 className="wa-card__title" id="optimizer-campaigns-title">Campaigns</h2>
          <p className="wa-card__sub">
            {rows.length} total · {assigned} assigned to a group · {withProposals} with a proposed change
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
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or campaign ID"
            type="search"
            value={query}
          />
        </label>
        <label className="wa-field">
          <span className="wa-label">Optimization group</span>
          <select className="wa-select wa-select--sm" onChange={(event) => setGroup(event.target.value)} value={group}>
            <option value="all">All groups</option>
            <option value="unassigned">Unassigned</option>
            {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="wa-field">
          <span className="wa-label">Campaign state</span>
          <select className="wa-select wa-select--sm" onChange={(event) => setState(event.target.value)} value={state}>
            <option value="all">All states</option>
            {states.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <span className="wa-optimizer-campaigns__shown">{filtered.length} shown</span>
        {query === '' && group === 'all' && state === 'all' ? null : (
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            onClick={() => { setQuery(''); setGroup('all'); setState('all'); }}
            type="button"
          >
            Clear filters
          </button>
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
          <button className="wa-btn wa-btn--ghost wa-btn--sm" onClick={() => { setQuery(''); setGroup('all'); setState('all'); }} type="button">
            Clear filters
          </button>
        </div>
      ) : (
        <div className="wa-tablewrap wa-optimizer-campaigns__tablewrap">
          <table className="wa-table wa-table--dense wa-table--numeric">
            <thead>
              <tr>
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
              {filtered.map((row) => (
                <tr key={row.campaignId}>
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
                      <a className="wa-badge wa-badge--warn" href={`/recommendations?profile=${profileId}&run=${run.id}`}>
                        {row.proposals} to review
                      </a>
                    ) : (
                      <span className="wa-hint">{recommendationState(run)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
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
