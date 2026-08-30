import { webRevision } from '../../../src/revision';

export const dynamic = 'force-dynamic';

/** Public liveness and immutable artifact identity. No tenancy or data access. */
export function GET(): Response {
  return Response.json(
    { status: 'ok', product: 'OpenSpell', revision: webRevision() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
