#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { createDb } from '@wizard-ads/db';
import { resolveReportWorkerRuntime } from './openspell-report-worker-contract.mjs';
import { verifyReportWorkerDatabaseReadiness } from './openspell-report-worker-readiness.mjs';

const releaseRoot = fileURLToPath(new URL('../', import.meta.url));
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;

if (!releaseRoot.startsWith('/opt/openspell-report-worker/releases/')) {
  throw new Error('OpenSpell report worker launcher is outside an immutable release');
}
if (!credentialDirectory) {
  throw new Error('systemd did not provide the report worker credential directory');
}

const runtime = await resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment: process.env,
});

try {
  await verifyReportWorkerDatabaseReadiness({
    databaseUrl: runtime.databaseUrl,
    createHandle: (connectionString) => createDb({
      connectionString,
      max: 1,
      statementTimeoutSeconds: 5,
    }),
  });
} catch {
  process.stderr.write('OpenSpell report worker database readiness failed\n');
  process.exit(1);
}

delete process.env.AMAZON_LWA_CLIENT_ID;
delete process.env.AMAZON_LWA_CLIENT_SECRET;
process.env.DATABASE_URL = runtime.databaseUrl;
process.env.LWA_CLIENT_ID = runtime.lwaClientId;
process.env.LWA_CLIENT_SECRET = runtime.lwaClientSecret;
process.env.WORKER_HEALTH_HOST = '127.0.0.1';
try {
  await import(new URL('../src/main.ts', import.meta.url));
} finally {
  delete process.env.DATABASE_URL;
  delete process.env.LWA_CLIENT_ID;
  delete process.env.LWA_CLIENT_SECRET;
  delete process.env.WORKER_HEALTH_HOST;
}
