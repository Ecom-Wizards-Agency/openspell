'use server';

/** Preview-only on-demand runner: mint the run, enqueue it, touch no Amazon API. */
import { revalidatePath } from 'next/cache';
import { PostgresRecommendationRunStore } from '@wizard-ads/worker';
import { authorize } from '../../src/auth/roles';
import { gateAction } from '../../src/auth/guard';

export async function runOptimizerNow(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'editTargets');
  const profileId = formData.get('profileId');
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new Error('no profile given');
  }

  const store = new PostgresRecommendationRunStore(handle);
  await store.enqueueRecommendationRun({
    orgId: active.orgId,
    profileId,
    source: 'web',
  });
  revalidatePath('/optimizer');
  revalidatePath('/recommendations');
}
