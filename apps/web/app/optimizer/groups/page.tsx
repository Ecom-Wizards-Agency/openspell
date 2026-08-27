/**
 * `/optimizer/groups` — Optimization Groups, surfaced as a concept.
 *
 * The recon (`tools/recon/04-optimizer.md` §4) describes an optimization group as
 * a named set of campaigns carrying its own target ACOS and prioritization, used
 * both as a settings carrier and as a data pool for low-data decisions. **Our
 * schema carries neither the group object nor the campaign→group assignment
 * yet**, so this page presents the grouping we *can* express — the campaign and
 * the strategy the run resolved for it — and says plainly that the real group
 * model is a gap. When that model lands, `optimizationGroups()` keys on it and
 * this page is unchanged.
 */
import type { ReactNode } from 'react';
import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '@wizard-ads/db';
import { gate } from '../../../src/auth/guard';
import { gateMessage } from '../../../src/ui/gate-message';
import { Badge, Banner, EmptyState, PageHeader } from '../../../src/ui/primitives';
import { page } from '../../../src/ui/tokens';
import { toProposalView } from '../../../src/recommendations/view';
import { optimizationGroups } from '../../../src/optimizer/view';
import { periodFromParams, todayIso } from '../../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../../_lib/profiles';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string; run?: string }>;
}

function acosLabel(value: number | null): string {
  return value === null ? 'mixed' : `${(value * 100).toFixed(0)}%`;
}

export default async function OptimizationGroupsPage({ searchParams }: PageProps): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Optimization Groups" />
        <p className="wa-page-sub">{gateMessage(entry.state)}</p>
      </main>
    );
  }
  const { handle, context } = entry;
  const orgId = context.active?.orgId ?? '';

  const params = await searchParams;
  const profileId = await requestedProfileId(params.profile);
  const period = periodFromParams(params, todayIso());

  const profiles = await listProfiles(handle, orgId);
  const profile = selectProfile(profiles, profileId);
  if (profile === null) {
    return (
      <main style={page}>
        <PageHeader title="Optimization Groups" />
        <EmptyState
          title="No profiles yet"
          body="This organisation has no advertising profiles. Connect Amazon Ads to populate the roster; optimization groups are derived from the recommendation run."
          action={
            <a className="wa-btn wa-btn--primary wa-btn--sm" href="/settings/connections">
              Connect Amazon Ads
            </a>
          }
        />
      </main>
    );
  }

  const runs = await listRecommendationRuns(handle, { orgId, profileId: profile.id, limit: 20 });
  const runId = params.run ?? runs[0]?.id ?? null;
  const run = runId === null ? null : await getRecommendationRun(handle, { orgId, runId });
  const records = run === null ? [] : await listRecommendations(handle, { orgId, runId: run.id });
  const proposals = records.map((record) =>
    toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null }),
  );
  const groups = optimizationGroups(proposals);

  return (
    <main style={page}>
      <PageHeader
        title="Optimization Groups"
        subtitle={`${profile.label} · ${period.start} to ${period.end}`}
        actions={
          <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
            Open the optimizer →
          </a>
        }
      />

      <div className="wa-stack">
        <Banner tone="warn" role="status">
          Optimization groups do not have a backing model yet: a group is a named set of campaigns
          with its own target ACOS and prioritization, and the schema carries neither the group nor
          the campaign→group assignment. Until it does, the grouping below stands in — one row per
          campaign, with the strategy the run resolved for it.
        </Banner>

        {run === null || groups.length === 0 ? (
          <EmptyState
            title="No groups to show"
            body="No recommendation run has produced proposals for this profile yet, so there is nothing to group."
            action={
              <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
                Open the optimizer
              </a>
            }
          />
        ) : (
          <div className="wa-tablewrap">
            <table className="wa-table wa-table--numeric">
              <thead>
                <tr>
                  <th scope="col">Group (campaign)</th>
                  <th scope="col">Target ACOS</th>
                  <th scope="col">Prioritization</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Proposals
                  </th>
                  <th scope="col">Reason clusters</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key} data-testid={`opt-group-${group.key}`}>
                    <td>{group.label}</td>
                    <td>{acosLabel(group.targetAcos)}</td>
                    <td>{group.objective ?? 'mixed'}</td>
                    <td style={{ textAlign: 'right' }}>{group.proposals.length}</td>
                    <td>
                      <span className="wa-row" style={{ gap: '0.25rem' }}>
                        {group.reasons.map((reason) => (
                          <Badge key={reason.label}>
                            {reason.label} · {reason.count}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
