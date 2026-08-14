/**
 * Entry point: `pnpm --filter @wizard-ads/mcp start`.
 *
 * Runs beside the worker on the same Fly app, on its own port.
 */
import { configFromEnv } from '../config.js';
import { startHttpServer } from '../http.js';

const config = configFromEnv();
const running = await startHttpServer({ config });

console.log(`[mcp] listening on ${config.host}:${running.port} (POST /mcp)`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.close().then(() => process.exit(0));
  });
}
