import { requestActor, errorResponse, openWebDatabase, requireOrgMembership } from '../../../../../src/server/request-context';
import { bulkAssignTagByFilter, bulkUnassignTagByFilter } from '@wizard-ads/db';
import type { TagEntityFilter, TaggableEntityType } from '@wizard-ads/db';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ tagId: string }> };

const TAGGABLE_TYPES = new Set<string>([
  'profile', 'portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative',
]);
const ENTITY_STATES = new Set<string>(['enabled', 'paused', 'archived']);

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

/** Validate the grid's filter before it reaches a query. */
function parseFilter(raw: Record<string, unknown> | undefined): TagEntityFilter {
  if (!raw || typeof raw['entityType'] !== 'string' || !TAGGABLE_TYPES.has(raw['entityType'])) {
    throw new Error('A valid filter.entityType is required');
  }
  const rawStates = stringList(raw['states']);
  if (rawStates && rawStates.some((state) => !ENTITY_STATES.has(state))) {
    throw new Error('Filter contains an invalid entity state');
  }
  return {
    entityType: raw['entityType'] as TaggableEntityType,
    ...(stringList(raw['profileIds']) ? { profileIds: stringList(raw['profileIds']) } : {}),
    ...(stringList(raw['entityIds']) ? { entityIds: stringList(raw['entityIds']) } : {}),
    ...(rawStates ? { states: rawStates as TagEntityFilter['states'] } : {}),
    ...(typeof raw['search'] === 'string' ? { search: raw['search'] } : {}),
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { tagId } = await context.params;
    const body = (await request.json()) as { filter?: Record<string, unknown> };
    const result = await bulkAssignTagByFilter(database, {
      orgId: actor.orgId,
      tagId,
      filter: parseFilter(body.filter),
      createdBy: actor.userId,
    });
    return Response.json({ result });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}

/** The inverse of POST: drop this tag from everything the filter matches. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const { tagId } = await context.params;
    const body = (await request.json()) as { filter?: Record<string, unknown> };
    const result = await bulkUnassignTagByFilter(database, {
      orgId: actor.orgId,
      tagId,
      filter: parseFilter(body.filter),
    });
    return Response.json({ result });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
