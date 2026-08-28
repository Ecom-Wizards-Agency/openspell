/**
 * The precedence in `mcpEndpoint` is the whole point of the function, and the
 * bug it replaced was invisible in review: appending `/mcp` to the web app's
 * own origin produced a URL that looked right and 404ed, because the MCP server
 * is a separate deploy target. The third case below is the regression guard —
 * `WIZARD_ADS_APP_URL` must not reach the result at all.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MCP_ENDPOINT, mcpEndpoint, optional, required } from './env';

/** `NodeJS.ProcessEnv` insists on `NODE_ENV`; nothing here reads it. */
const env = (values: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...values,
});

describe('mcpEndpoint', () => {
  it('prefers the explicit public URL over everything else', () => {
    const endpoint = mcpEndpoint(
      env({
        NEXT_PUBLIC_MCP_URL: 'https://mcp.example.test/mcp',
        WIZARD_ADS_MCP_URL: 'https://server-var.example.test/mcp',
        WIZARD_ADS_APP_URL: 'https://app.example.test',
      }),
    );
    expect(endpoint).toBe('https://mcp.example.test/mcp');
  });

  it('falls back to the server variable when the public one is unset', () => {
    const endpoint = mcpEndpoint(
      env({
        WIZARD_ADS_MCP_URL: 'https://server-var.example.test/mcp',
        WIZARD_ADS_APP_URL: 'https://app.example.test',
      }),
    );
    expect(endpoint).toBe('https://server-var.example.test/mcp');
  });

  it('uses the exact production endpoint rather than deriving from the app origin', () => {
    const endpoint = mcpEndpoint(env({ WIZARD_ADS_APP_URL: 'https://app.example.test' }));
    expect(endpoint).toBe('https://mcp.ecomwizards.agency/mcp');
    expect(endpoint).toBe(DEFAULT_MCP_ENDPOINT);
    expect(endpoint).not.toContain('app.example.test');
  });

  it('treats an empty string as unset', () => {
    expect(mcpEndpoint(env({ NEXT_PUBLIC_MCP_URL: '', WIZARD_ADS_MCP_URL: '' }))).toBe(
      DEFAULT_MCP_ENDPOINT,
    );
  });
});

describe('required and optional', () => {
  it('names the missing variable', () => {
    expect(() => required('SOME_MISSING_VAR', env())).toThrow(/SOME_MISSING_VAR is not set/);
  });

  it('returns the fallback only when the value is absent or empty', () => {
    expect(optional('A', 'fallback', env())).toBe('fallback');
    expect(optional('A', 'fallback', env({ A: '' }))).toBe('fallback');
    expect(optional('A', 'fallback', env({ A: 'set' }))).toBe('set');
  });
});
