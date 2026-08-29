/**
 * `/optimizer/groups` — campaign review groups until the real group model lands.
 *
 * The recon (`tools/recon/04-optimizer.md` §4) describes an optimization group as
 * a named set of campaigns carrying its own target ACOS and prioritization, used
 * both as a settings carrier and as a data pool for low-data decisions. **Our
 * schema carries neither the group object nor the campaign→group assignment
 * yet**, so this page presents the grouping we *can* express — the campaign and
 * the strategy the run resolved for it — and says plainly that the real group
 * model is a gap. The current page therefore names campaign buckets honestly.
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
import { campaignReviewGroups } from '../../../src/optimizer/view';
import { periodFromParams, todayIso } from '../../_lib/periods';
import { listProfiles, requestedProfileId, selectProfile } from '../../_lib/profiles';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string; from?: string; to?: string; run?: string }>;
}

function acosLabel(value: number | null): string {
  return value === null ? 'mixed' : `${(value * 100).toFixed(0)}%`;
}

export default async function CampaignReviewGroupsPage({ searchParams }: PageProps): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Campaign Review Groups" />
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
        <PageHeader title="Campaign Review Groups" />
        <EmptyState
          title="No profiles yet"
          body="This organisation has no advertising profiles. Connect Amazon Ads to populate the roster; campaign review groups come from recommendation runs."
          action={
            <a className="wa-btn wa-btn--sm" href="/settings/connections">
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
  const groups = campaignReviewGroups(proposals);

  return (
    <main style={page}>
      <PageHeader
        title="Campaign Review Groups"
        subtitle={`${profile.label} · ${period.start} to ${period.end}`}
        actions={
          <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
            Open the optimizer →
          </a>
        }
      />

      <div className="wa-stack">
        <Banner tone="warn" role="status">
          Persisted optimization groups are not available yet. The table below groups proposals by
          campaign for review and shows the strategy resolved for each bucket; it is not a saved
          tier or campaign assignment.
        </Banner>

        {run === null || groups.length === 0 ? (
          <EmptyState
            title="No campaign groups to show"
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
                  <th scope="col">Campaign</th>
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
                  <tr key={group.key} data-testid={`campaign-review-group-${group.key}`}>
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
