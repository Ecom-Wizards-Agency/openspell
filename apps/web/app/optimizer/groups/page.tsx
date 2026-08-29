import type { ReactNode } from 'react';
import { readOptimizationWorkspace } from '@wizard-ads/db';
import { gate } from '../../../src/auth/guard';
import { can } from '../../../src/auth/roles';
import { gateMessage } from '../../../src/ui/gate-message';
import { EmptyState, PageHeader } from '../../../src/ui/primitives';
import { page } from '../../../src/ui/tokens';
import { listProfiles, requestedProfileId, selectProfile } from '../../_lib/profiles';
import { OptimizationGroupsManager } from './groups-manager';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string }>;
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
  const profiles = await listProfiles(handle, orgId);
  const profile = selectProfile(profiles, profileId);

  if (profile === null) {
    return (
      <main style={page}>
        <PageHeader title="Optimization Groups" />
        <EmptyState
          title="No profiles yet"
          body="Connect Amazon Ads before assigning campaigns to optimization groups."
          action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
        />
      </main>
    );
  }

  const workspace = await readOptimizationWorkspace(handle, { orgId, profileId: profile.id });

  return (
    <main style={page}>
      <PageHeader
        title="Optimization Groups"
        subtitle={`${profile.label} · one policy and evidence cadence per campaign`}
        actions={<a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>Open optimizer →</a>}
      />
      <OptimizationGroupsManager
        profileId={profile.id}
        initial={workspace}
        canManage={can(context.active?.role, 'editTargets')}
      />
    </main>
  );
}
