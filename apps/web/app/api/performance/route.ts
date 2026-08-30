import { parseBrowserPerformanceEvent } from '../../../src/performance/events';
import { publicRevision } from '../../../src/performance/revision';

const MAX_EVENT_BYTES = 1_024;
const NO_STORE = { 'cache-control': 'no-store' } as const;

// This cookie-free endpoint is intentionally non-authoritative. It supports
// debugging distributions without collecting identity; the fixed evidence
// classification prevents these events from satisfying a release gate.

export function GET(): Response {
  return Response.json(publicRevision(), {
    headers: { ...NO_STORE, 'x-openspell-performance-evidence': 'diagnostic-only' },
  });
}

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_BYTES) {
    return Response.json({ error: 'invalid performance event' }, { status: 400, headers: NO_STORE });
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES) {
    return Response.json({ error: 'invalid performance event' }, { status: 400, headers: NO_STORE });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return Response.json({ error: 'invalid performance event' }, { status: 400, headers: NO_STORE });
  }
  const event = parseBrowserPerformanceEvent(raw);
  const deployed = publicRevision().revision;
  if (event === null || deployed === null) {
    return Response.json({ error: 'invalid performance event' }, { status: 400, headers: NO_STORE });
  }
  if (event.revision !== deployed) {
    return Response.json({ error: 'revision mismatch' }, { status: 409, headers: NO_STORE });
  }

  console.info(JSON.stringify(event));
  return new Response(null, {
    status: 204,
    headers: { ...NO_STORE, 'x-openspell-performance-evidence': 'diagnostic-only' },
  });
}
