/** Complete Grid rows behind an authenticated, tenant-scoped HTTP boundary. */
import { ENTITY_LEVELS } from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import { loadGridRows } from '../../../_lib/grid-data';
import { precedingPeriod } from '../../../_lib/periods';
import { requireOrgRole } from '../../../../src/server/org-role';
import {
  openWebDatabase,
  requestActor,
  RequestAuthError,
} from '../../../../src/server/request-context';
import { GridServerTiming } from './server-timing';
import { serializeGridPayloadWithinBudget } from './serialize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRIVATE_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
} as const;

class GridRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GridRequestError';
  }
}

interface GridRowsQuery {
  profileId: string;
  entity: EntityLevel;
  period: { start: string; end: string };
}

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseGridRowsQuery(requestUrl: string): GridRowsQuery {
  const query = new URL(requestUrl).searchParams;
  const profileId = query.get('profile') ?? '';
  const entity = query.get('entity') ?? '';
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';

  if (!UUID.test(profileId)) throw new GridRequestError('profile must be a UUID');
  if (!ENTITY_LEVELS.includes(entity as EntityLevel)) {
    throw new GridRequestError(`entity must be one of: ${ENTITY_LEVELS.join(', ')}`);
  }
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw new GridRequestError('from and to must be an ordered ISO date window');
  }

  return {
    profileId,
    entity: entity as EntityLevel,
    period: { start: from, end: to },
  };
}

function json(value: unknown, init: { status?: number } = {}): Response {
  return Response.json(value, {
    status: init.status,
    headers: PRIVATE_RESPONSE_HEADERS,
  });
}

function gridPayloadResponse(
  payload: Awaited<ReturnType<typeof loadGridRows>>,
  timing: GridServerTiming,
): Response {
  const serialized = serializeGridPayloadWithinBudget(payload);
  timing.mark('serialize');
  return new Response(serialized.body, {
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Server-Timing': timing.header(),
    },
  });
}

function gridErrorResponse(error: unknown): Response {
  if (error instanceof RequestAuthError) {
    return json({ error: error.message }, { status: error.status });
  }
  if (error instanceof GridRequestError) {
    return json({ error: error.message }, { status: 400 });
  }
  return json({ error: 'Could not load Grid rows' }, { status: 500 });
}

export async function GET(request: Request): Promise<Response> {
  const timing = new GridServerTiming();
  let database: ReturnType<typeof openWebDatabase> | null = null;
  try {
    database = openWebDatabase();
    const actor = await requestActor(request.headers);
    timing.mark('actor');
    await requireOrgRole(database, actor);
    timing.mark('role');
    const { profileId, entity, period } = parseGridRowsQuery(request.url);

    // The browser supplies only the profile identity. Currency and tenancy are
    // server-owned facts, resolved together so a foreign and an unknown profile
    // are indistinguishable from outside the organization.
    const [profile] = await database.sql<{ currency_code: string }[]>`
      select currency_code::text as currency_code
        from public.ad_profiles
       where org_id = ${actor.orgId}
         and id = ${profileId}
       limit 1
    `;
    timing.mark('profile');
    if (profile === undefined) return json({ error: 'Not found' }, { status: 404 });

    const payload = await loadGridRows(database, entity, {
      orgId: actor.orgId,
      profileId,
      currencyCode: profile.currency_code,
      period,
      comparison: precedingPeriod(period),
    });
    timing.mark('rows');

    return gridPayloadResponse(payload, timing);
  } catch (error) {
    return gridErrorResponse(error);
  } finally {
    await database?.close();
  }
}
