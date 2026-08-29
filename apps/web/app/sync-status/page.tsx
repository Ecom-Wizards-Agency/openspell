/**
 * `/sync-status` — what the sync engine did, unedited.
 *
 * Read-only and deliberately plain (WP-06 owns look and feel). Three tables:
 * freshness per profile, the job queue, the report ledger. The report ledger
 * shows base-report parsed/loaded equality and attribution-aware
 * source/refused/promoted/unpromoted/canonical reconciliation, because "the
 * job succeeded" and "every source row was accounted for" are different
 * claims and only the second one is worth anything.
 */
import type { ReactNode } from 'react';
import { gate } from '../../src/auth/guard';
import { loadSyncStatus, reportAccountingLabel } from '../../src/data/sync-status';
import { Shell } from '../../src/ui/shell';
import { banner, colors, heading, muted, page, subheading, table, td, th } from '../../src/ui/tokens';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{ profile?: string }>;
}

export default async function SyncStatusPage({ searchParams }: Props): Promise<ReactNode> {
  const query = await searchParams;
  const result = await gate();

  if (result.state !== 'ok') {
    return (
      <main style={page}>
        <h1 style={heading}>Sync status</h1>
        <p style={banner('warn')}>
          {result.state === 'no-database'
            ? 'DATABASE_URL is not set, so this instance cannot read its own database.'
            : 'Your account is not a member of any organisation yet.'}
        </p>
      </main>
    );
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const status = await loadSyncStatus(handle, org.orgId, query.profile ?? null);

  return (
    <main style={page}>
      <Shell context={context} current="sync">
        <h1 style={heading}>Sync status</h1>
        <p style={muted}>
          Freshness is the newest fact date a profile holds, not the last time a job ran. Same-day
          figures are provisional and sales restate for about fourteen days, so a fresh date is not
          a final one.
        </p>

        <h2 style={subheading}>Profiles</h2>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Profile</th>
              <th style={th}>Region</th>
              <th style={th}>Sync</th>
              <th style={th}>Newest facts</th>
              <th style={th}>Queued</th>
              <th style={th}>Running</th>
              <th style={th}>Failed</th>
            </tr>
          </thead>
          <tbody>
            {status.freshness.map((row) => (
              <tr key={row.profileId} data-testid="freshness-row">
                <td style={td}>
                  <a href={`/sync-status?profile=${row.profileId}`}>{row.profileLabel}</a>
                </td>
                <td style={td}>{row.region}</td>
                <td style={td}>{row.syncEnabled ? 'on' : 'off'}</td>
                <td style={td}>{row.latestFactDate ?? 'never'}</td>
                <td style={td}>{row.queued}</td>
                <td style={td}>{row.running}</td>
                <td style={{ ...td, color: row.failed > 0 ? colors.bad : undefined }}>
                  {row.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.freshness.length === 0 ? <p style={muted}>No profiles yet.</p> : null}

        <h2 style={subheading}>Jobs</h2>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Profile</th>
              <th style={th}>Type</th>
              <th style={th}>Status</th>
              <th style={th}>Attempts</th>
              <th style={th}>Run after</th>
              <th style={th}>Finished</th>
              <th style={th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {status.jobs.map((job) => (
              <tr key={job.id} data-testid="job-row">
                <td style={td}>{job.profileLabel}</td>
                <td style={td}>{job.jobType}</td>
                <td style={td}>{job.status}</td>
                <td style={td}>
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td style={td}>{job.runAfter ?? '—'}</td>
                <td style={td}>{job.finishedAt ?? '—'}</td>
                <td style={{ ...td, color: job.lastError ? colors.bad : undefined }}>
                  {job.lastError ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.jobs.length === 0 ? <p style={muted}>Nothing has been queued yet.</p> : null}

        <h2 style={subheading}>Report requests</h2>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Profile</th>
              <th style={th}>Report</th>
              <th style={th}>Window</th>
              <th style={th}>Status</th>
              <th style={th}>Polls</th>
              <th style={th}>Source</th>
              <th style={th}>Parsed</th>
              <th style={th}>Refused</th>
              <th style={th}>Promoted</th>
              <th style={th}>Unpromoted</th>
              <th style={th}>Loaded / canonical</th>
              <th style={th}>Reconciliation</th>
              <th style={th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {status.reports.map((report) => (
              <tr key={report.id} data-testid="report-row">
                <td style={td}>{report.profileLabel}</td>
                <td style={td}>{report.reportType}</td>
                <td style={td}>
                  {report.startDate} → {report.endDate}
                </td>
                <td style={td}>{report.status}</td>
                <td style={td}>{report.pollAttempts}</td>
                <td style={td}>{report.sourceRows ?? '—'}</td>
                <td style={td}>{report.rowsParsed ?? '—'}</td>
                <td style={td}>{report.refusedRows ?? '—'}</td>
                <td style={td}>{report.promotedRows ?? '—'}</td>
                <td style={td}>{report.unpromotedRows ?? '—'}</td>
                <td style={td}>{report.rowsLoaded ?? '—'}</td>
                <td
                  style={{
                    ...td,
                    color: report.accountingComplete === false || (
                      report.accountingComplete === null && report.countsMatch === false
                    ) ? colors.bad : undefined,
                  }}
                >
                  {reportAccountingLabel(report)}
                </td>
                <td style={{ ...td, color: report.error ? colors.bad : undefined }}>
                  {report.error ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status.reports.length === 0 ? <p style={muted}>No reports requested yet.</p> : null}
      </Shell>
    </main>
  );
}
