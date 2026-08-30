/** Complete Grid rows behind an authenticated, tenant-scoped HTTP boundary. */
import { ENTITY_LEVELS } from '@wizard-ads/ui';
import type { EntityLevel } from '@wizard-ads/ui';
import { loadGridRows } from '../../../_lib/grid-data';
import { precedingPeriod } from '../../../_lib/periods';
import { authorizeGridRequest } from '../../../../src/grid/request-context';
import { RequestAuthError } from '../../../../src/server/request-context';
import { finalizeTimedGridResponse, GridServerTiming } from './server-timing';
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

interface ParsedGridRowsQuery {
  ok: true;
  query: GridRowsQuery;
  candidateProfileId: string;
}

interface RejectedGridRowsQuery {
  ok: false;
  error: GridRequestError;
  candidateProfileId: string | null;
}

type GridRowsQueryAttempt = ParsedGridRowsQuery | RejectedGridRowsQuery;

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

/** Parse without changing the authentication-before-input-refusal contract. */
function attemptGridRowsQuery(requestUrl: string): GridRowsQueryAttempt {
  let candidateProfileId: string | null = null;
  try {
    const rawProfileId = new URL(requestUrl).searchParams.get('profile') ?? '';
    candidateProfileId = UUID.test(rawProfileId) ? rawProfileId : null;
    return {
      ok: true,
      query: parseGridRowsQuery(requestUrl),
      candidateProfileId: rawProfileId,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof GridRequestError
          ? error
          : new GridRequestError('Could not parse Grid request'),
      candidateProfileId,
    };
  }
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
    },
  });
}

function gridErrorResponse(error: unknown): Response {
  if (error instanceof RequestAuthError) {
    return json(
      {
        error: error.message,
        ...(error.code === null ? {} : { code: error.code }),
        ...(error.location === null ? {} : { location: error.location }),
      },
      { status: error.status },
    );
  }
  if (error instanceof GridRequestError) {
    return json({ error: error.message }, { status: 400 });
  }
  return json({ error: 'Could not load Grid rows' }, { status: 500 });
}

interface GridRowsRouteRuntime {
  authorizeRequest: typeof authorizeGridRequest;
  loadRows: typeof loadGridRows;
}

const DEFAULT_RUNTIME: GridRowsRouteRuntime = {
  authorizeRequest: authorizeGridRequest,
  loadRows: loadGridRows,
};

/** Exported only so route tests can prove handle identity and close cardinality. */
export function createGridRowsGet(
  runtime: GridRowsRouteRuntime = DEFAULT_RUNTIME,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const timing = new GridServerTiming();
    const queryAttempt = attemptGridRowsQuery(request.url);
    let database: Awaited<ReturnType<typeof authorizeGridRequest>>['database'] | null = null;
    let success: Response | null = null;
    try {
      // One deep operation establishes identity before opening a database and
      // returns the same handle whose receipt scopes the facts query. Invalid
      // input is retained but not refused until membership is established.
      const authorized = await runtime.authorizeRequest({
        headers: request.headers,
        candidateProfileId: queryAttempt.candidateProfileId,
        identityVerified: () => timing.mark('actor'),
      });
      database = authorized.database;
      const { receipt } = authorized;
      timing.mark('role');

      if (!queryAttempt.ok) throw queryAttempt.error;
      timing.mark('profile');
      if (receipt.profileId === null || receipt.currencyCode === null) {
        return json({ error: 'Not found' }, { status: 404 });
      }
      const { entity, period } = queryAttempt.query;

      // Tenant, profile, and currency all come from one membership-fenced
      // receipt. The browser cannot splice together pieces from other orgs.
      const payload = await runtime.loadRows(database, entity, {
        orgId: receipt.orgId,
        profileId: receipt.profileId,
        currencyCode: receipt.currencyCode,
        period,
        comparison: precedingPeriod(period),
      });
      timing.mark('rows');

      success = gridPayloadResponse(payload, timing);
      return success;
    } catch (error) {
      return gridErrorResponse(error);
    } finally {
      const openedDatabase = database;
      if (openedDatabase !== null) {
        if (success === null) await openedDatabase.close();
        else await finalizeTimedGridResponse(success, timing, () => openedDatabase.close());
      }
    }
  };
}

export const GET = createGridRowsGet();
