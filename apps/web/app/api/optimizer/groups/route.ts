import {
  readOptimizationWorkspace,
  saveOptimizationGroup,
  type OptimizationGroupSettings,
} from '@wizard-ads/db';
import {
  OptimizationGroupRole,
  OptimizationPrioritization,
  OptimizationReviewSchedule,
} from '@wizard-ads/shared';
import { openWebDatabase, requestActor, errorResponse } from '../../../../src/server/request-context';
import { requireCapability, requireOrgRole } from '../../../../src/server/org-role';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgRole(database, actor);
    const profileId = new URL(request.url).searchParams.get('profileId');
    if (!profileId) throw new Error('profileId is required');
    return Response.json(await readOptimizationWorkspace(database, {
      orgId: actor.orgId,
      profileId,
    }));
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = await request.json() as Record<string, unknown>;
    const profileId = requiredString(body['profileId'], 'profileId');
    const settings: OptimizationGroupSettings = {
      name: requiredString(body['name'], 'name'),
      role: OptimizationGroupRole.parse(body['role']),
      targetAcos: fraction(body['targetAcosPercent'], 'targetAcosPercent'),
      bidFloor: optionalNonnegative(body['bidFloor'], 'bidFloor'),
      bidCeiling: optionalNonnegative(body['bidCeiling'], 'bidCeiling'),
      bidIncreaseCap: fraction(body['bidIncreaseCapPercent'], 'bidIncreaseCapPercent'),
      bidDecreaseCap: fraction(body['bidDecreaseCapPercent'], 'bidDecreaseCapPercent'),
      placementIncreaseCap: fraction(
        body['placementIncreaseCapPercent'],
        'placementIncreaseCapPercent',
      ),
      placementDecreaseCap: fraction(
        body['placementDecreaseCapPercent'],
        'placementDecreaseCapPercent',
      ),
      exclusions: stringArray(body['exclusions'], 'exclusions'),
      reviewSchedule: OptimizationReviewSchedule.parse({
        weekdays: body['reviewWeekdays'],
        localTime: body['reviewLocalTime'],
      }),
      prioritization: OptimizationPrioritization.parse(body['prioritization']),
      enabled: body['enabled'] !== false,
    };
    if (
      settings.bidFloor !== null &&
      settings.bidCeiling !== null &&
      settings.bidFloor > settings.bidCeiling
    ) {
      throw new Error('bid floor cannot exceed bid ceiling');
    }
    const result = await saveOptimizationGroup(database, {
      orgId: actor.orgId,
      profileId,
      actorId: actor.userId,
      ...(typeof body['id'] === 'string' && body['id'].length > 0 ? { id: body['id'] } : {}),
      settings,
      campaignIds: stringArray(body['campaignIds'], 'campaignIds'),
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a number`);
  return parsed;
}

function fraction(value: unknown, field: string): number {
  const percent = finiteNumber(value, field);
  if (percent < 0) throw new Error(`${field} must be nonnegative`);
  return percent / 100;
}

function optionalNonnegative(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = finiteNumber(value, field);
  if (parsed < 0) throw new Error(`${field} must be nonnegative`);
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}
