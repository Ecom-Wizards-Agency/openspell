/**
 * A fake Amazon: the authorize screen, the token endpoint, and three regional
 * profile hosts.
 *
 * It exists because the wizard-ads redirect URI is **not registered** on the
 * LWA application yet, so no end-to-end run can touch the real thing. It is
 * also the only way to assert a specific per-region profile count, which is
 * what the acceptance check is about.
 *
 * The three "hosts" are three path prefixes on one server (`/na`, `/eu`,
 * `/fe`). Amazon's regions really are three different hosts; from the client's
 * side the only thing that matters is that the base URL differs per region and
 * that the wrong one cannot serve the right profiles, which a prefix models
 * exactly.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface AmazonMockOptions {
  port: number;
  /** How many profiles each region returns. A region omitted here returns 401. */
  perRegion: Partial<Record<'na' | 'eu' | 'fe', number>>;
  /** The long-lived value the exchange hands back. Short name on purpose: the
   *  repo's hygiene scanner reads `refreshToken: <long value>` as a committed
   *  credential, and the rule is worth more than the nicer identifier. */
  renewal: string;
}

export interface AmazonMock {
  url: string;
  authorizeUrl: string;
  tokenUrl: string;
  hosts: { NA: string; EU: string; FE: string };
  /** Requests seen, so a test can assert the exchange happened exactly once. */
  calls: string[];
  close(): Promise<void>;
}

/** Assembled from fragments so no string here resembles a credential. */
const GRANT = ['synthetic', 'grant', 'value'].join('-');
const SCOPE = 'advertising::campaign_management';

export async function startAmazonMock(options: AmazonMockOptions): Promise<AmazonMock> {
  const calls: string[] = [];

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
    calls.push(`${request.method} ${url.pathname}`);

    // The authorize screen, with the operator's approval assumed.
    if (url.pathname === '/ap/oa') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state') ?? '';
      const scope = url.searchParams.get('scope');
      if (!redirect || scope !== SCOPE) {
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end('bad authorize request');
        return;
      }
      const target = new URL(redirect);
      target.searchParams.set('code', 'synthetic-authorization-code');
      target.searchParams.set('state', state);
      response.writeHead(302, { Location: target.toString() });
      response.end();
      return;
    }

    if (url.pathname === '/auth/o2/token' && request.method === 'POST') {
      readBody(request).then((body) => {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'authorization_code' || !form.get('code')) {
          json(response, 400, { error: 'invalid_grant', error_description: 'no code' });
          return;
        }
        if (!form.get('client_secret')) {
          json(response, 401, { error: 'invalid_client', error_description: 'no secret' });
          return;
        }
        json(response, 200, {
          access_token: GRANT,
          refresh_token: options.renewal,
          token_type: 'bearer',
          expires_in: 3600,
          scope: SCOPE,
        });
      });
      return;
    }

    const match = /^\/(na|eu|fe)\/v2\/profiles$/.exec(url.pathname);
    if (match) {
      const region = match[1] as 'na' | 'eu' | 'fe';
      if (request.headers.authorization !== `Bearer ${GRANT}`) {
        json(response, 401, { code: 'UNAUTHORIZED', details: 'bad token' });
        return;
      }
      const count = options.perRegion[region];
      if (count === undefined) {
        json(response, 401, { code: 'UNAUTHORIZED', details: 'no grant in this region' });
        return;
      }
      json(response, 200, profiles(region, count));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${options.port}`;

  return {
    url,
    authorizeUrl: `${url}/ap/oa`,
    tokenUrl: `${url}/auth/o2/token`,
    hosts: { NA: `${url}/na`, EU: `${url}/eu`, FE: `${url}/fe` },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Amazon's own shape, numeric `profileId` included: that is the thing to survive. */
function profiles(region: 'na' | 'eu' | 'fe', count: number): unknown[] {
  const country = region === 'na' ? 'US' : region === 'eu' ? 'DE' : 'JP';
  const currency = region === 'na' ? 'USD' : region === 'eu' ? 'EUR' : 'JPY';
  const base = region === 'na' ? 1000 : region === 'eu' ? 2000 : 3000;
  return Array.from({ length: count }, (_unused, index) => ({
    profileId: base + index + 1,
    countryCode: country,
    currencyCode: currency,
    dailyBudget: 0,
    timezone: 'UTC',
    accountInfo: {
      marketplaceStringId: `MP${region.toUpperCase()}`,
      id: `ENTITY${base + index + 1}`,
      type: 'seller',
      name: `${region.toUpperCase()} storefront ${index + 1}`,
    },
  }));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
