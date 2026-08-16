/**
 * Server environment, read in one place.
 *
 * Two rules this file exists to keep:
 *
 *  - **Secrets are server-only.** The LWA client secret, the state signing key
 *    and the database URL are read here and nowhere a bundle can reach. Only
 *    `NEXT_PUBLIC_*` values cross to the browser, and the two that do are the
 *    Supabase URL and anon key, which are public by design.
 *  - **A missing variable names itself.** A driver error six frames deep costs
 *    an hour; `AMAZON_LWA_CLIENT_SECRET is not set` costs a minute.
 *
 * The Amazon endpoints are configurable with real defaults. That is not
 * indirection for its own sake: the end-to-end test points them at a local
 * mock, which is the only way to exercise the callback without a live grant.
 */
import { Region } from '@wizard-ads/shared';

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. See apps/web/env.TEMPLATE.`);
  return value;
}

export function optional(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[name] || fallback;
}

/**
 * The MCP endpoint an operator pastes into their client.
 *
 * Never derive this from `WIZARD_ADS_APP_URL`. The MCP server is a separate
 * deploy target — `apps/mcp`, Streamable HTTP on its own port on the worker's
 * Fly app — while the web app runs on Vercel and serves no `/mcp` route at all.
 * Appending `/mcp` to the app origin therefore produces a URL that looks right,
 * copies cleanly off `/connect-claude`, and 404s. A visible placeholder is the
 * better failure: it cannot be mistaken for a working endpoint.
 *
 * `WIZARD_ADS_MCP_URL` is the same name `apps/analyst` already reads, so one
 * value configures both consumers.
 */
export const MCP_ENDPOINT_PLACEHOLDER = 'https://<your-wizard-ads-host>/mcp';

export function mcpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env['NEXT_PUBLIC_MCP_URL'] || env['WIZARD_ADS_MCP_URL'] || MCP_ENDPOINT_PLACEHOLDER;
}

/** Amazon's LWA endpoints, and the hosts the profile fetch talks to. */
export interface AmazonOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
  authorizeUrl: string;
  tokenUrl: string;
  hosts: Record<Region, string>;
}

export const DEFAULT_ADS_HOSTS: Record<Region, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
};

export const REGIONS: readonly Region[] = Region.options;

export function amazonOAuthConfig(env: NodeJS.ProcessEnv = process.env): AmazonOAuthConfig {
  return {
    clientId: required('AMAZON_LWA_CLIENT_ID', env),
    clientSecret: required('AMAZON_LWA_CLIENT_SECRET', env),
    redirectUri: required('AMAZON_OAUTH_REDIRECT_URI', env),
    // The one scope the tool needs. Widening it is a deliberate act, not a
    // default, so it is written here rather than read from the environment.
    scope: 'advertising::campaign_management',
    authorizeUrl: optional('AMAZON_LWA_AUTHORIZE_URL', 'https://www.amazon.com/ap/oa', env),
    tokenUrl: optional('AMAZON_LWA_TOKEN_URL', 'https://api.amazon.com/auth/o2/token', env),
    hosts: {
      NA: optional('AMAZON_ADS_HOST_NA', DEFAULT_ADS_HOSTS.NA, env),
      EU: optional('AMAZON_ADS_HOST_EU', DEFAULT_ADS_HOSTS.EU, env),
      FE: optional('AMAZON_ADS_HOST_FE', DEFAULT_ADS_HOSTS.FE, env),
    },
  };
}

/** HMAC key for the OAuth `state`. Length is enforced where it is used. */
export function stateSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  return required('AMAZON_OAUTH_STATE_KEY', env);
}

/**
 * Is this deployment served over https? Decides whether the nonce cookie can
 * carry the `__Host-` prefix, which browsers refuse over plain http.
 */
export function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env['WIZARD_ADS_SECURE_COOKIES'];
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return env['NODE_ENV'] === 'production';
}
