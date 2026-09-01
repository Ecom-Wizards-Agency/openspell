import { resolveWebRevisionIdentity } from '../../../src/revision';

export const dynamic = 'force-dynamic';

/** Public liveness and immutable artifact identity. No tenancy or data access. */
export function GET(): Response {
  const identity = resolveWebRevisionIdentity();
  return Response.json(
    {
      status: 'ok',
      product: 'OpenSpell',
      revision: identity.revision,
      revisionSource: identity.source,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
