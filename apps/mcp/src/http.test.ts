import { afterEach, describe, expect, it } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_ROWS } from './config.js';
import { startHttpServer } from './http.js';
import type { McpConfig } from './config.js';
import type { RunningServer } from './http.js';

describe('MCP health readiness', () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('returns only controlled metadata when ready', async () => {
    running = await startHttpServer({
      config: testConfig(),
      handle: {} as DbHandle,
      readinessProbe: async () => {},
    });

    const response = await fetch(running.url.replace('/mcp', '/healthz'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      service: 'openspell',
      product: 'OpenSpell',
      version: '0.1.0',
      revision: 'abcdef123456',
      checks: { database: 'ready' },
    });
  });

  it('returns 503 without leaking the readiness error', async () => {
    const privateDetail = 'private connection detail';
    running = await startHttpServer({
      config: testConfig(),
      handle: {} as DbHandle,
      readinessProbe: async () => {
        throw new Error(privateDetail);
      },
    });

    const response = await fetch(running.url.replace('/mcp', '/healthz'));
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).not.toContain(privateDetail);
    expect(JSON.parse(text)).toEqual({
      status: 'not_ready',
      service: 'openspell',
      product: 'OpenSpell',
      version: '0.1.0',
      revision: 'abcdef123456',
      checks: { database: 'not_ready' },
    });
  });

  it('does not expose an unsanitized revision supplied by an embedding caller', async () => {
    const config = testConfig();
    config.revision = 'release/private-detail';
    running = await startHttpServer({
      config,
      handle: {} as DbHandle,
      readinessProbe: async () => {},
    });

    const response = await fetch(running.url.replace('/mcp', '/healthz'));
    const payload = (await response.json()) as { revision?: unknown };
    expect(payload.revision).toBe('unknown');
  });
});

function testConfig(): McpConfig {
  return {
    connectionString: 'postgresql://localhost/wizard_ads_test',
    port: 0,
    host: '127.0.0.1',
    webBaseUrl: 'http://localhost:3000',
    revision: 'abcdef123456',
    poolSize: 1,
    statementTimeoutSeconds: 5,
    maxRows: DEFAULT_MAX_ROWS,
    maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
    writeToolsEnabled: false,
  };
}
