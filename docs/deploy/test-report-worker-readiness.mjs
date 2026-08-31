#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import process from 'node:process';
import { createDb } from '../../packages/db/src/client.ts';
import { verifyReportWorkerDatabaseReadiness } from './openspell-report-worker-readiness.mjs';

const expectedFailure = 'OpenSpell report worker database readiness failed';

function fakeHandle(contract, statements, { failWith } = {}) {
  const tag = async (parts) => {
    const text = parts.raw.join(' ').replaceAll(/\s+/gu, ' ').trim().toLowerCase();
    statements.push(text);
    if (failWith) throw new Error(failWith);
    if (text.includes('limit 0')) return [];
    return [contract];
  };
  tag.begin = async (mode, callback) => {
    assert.equal(mode, 'read only');
    return callback(tag);
  };
  tag.end = async () => undefined;
  return { sql: tag, close: async () => undefined };
}

const ready = {
  transaction_read_only: true,
  service_role_ready: true,
  queue_relation_ready: true,
  queue_type_ready: true,
  claim_function_ready: true,
  queue_read_ready: true,
  queue_type_access_ready: true,
  claim_execute_ready: true,
};
const statements = [];
await verifyReportWorkerDatabaseReadiness({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, statements),
});
assert.equal(statements.length, 2);
assert.match(statements[0], /has_function_privilege/u);
assert.match(statements[1], /select id from public\.sync_jobs limit 0/u);
assert.doesNotMatch(statements.join(' '), /\b(insert|update|delete|call)\b/u);

for (const key of Object.keys(ready)) {
  const refused = { ...ready, [key]: false };
  await assert.rejects(
    verifyReportWorkerDatabaseReadiness({
      databaseUrl: 'synthetic',
      createHandle: () => fakeHandle(refused, []),
    }),
    (error) => error?.message === expectedFailure,
  );
}

const privateDetail = ['postgres://', 'operator', ':', 'private-value', '@private-host'].join('');
await assert.rejects(
  verifyReportWorkerDatabaseReadiness({
    databaseUrl: 'synthetic',
    createHandle: () => fakeHandle(ready, [], { failWith: privateDetail }),
  }),
  (error) => error?.message === expectedFailure && !error.message.includes(privateDetail),
);

const silentSockets = new Set();
const silentServer = createServer((socket) => {
  silentSockets.add(socket);
  socket.once('close', () => silentSockets.delete(socket));
});
silentServer.listen(0, '127.0.0.1');
await once(silentServer, 'listening');
const address = silentServer.address();
assert.ok(address && typeof address !== 'string');
const url = ['postgres://', 'probe', ':', 'probe', '@127.0.0.1:', address.port, '/probe'].join('');
const startedAt = Date.now();
await assert.rejects(
  verifyReportWorkerDatabaseReadiness({
    databaseUrl: url,
    timeoutMs: 200,
    createHandle: (connectionString) => createDb({
      connectionString,
      max: 1,
      statementTimeoutSeconds: 1,
    }),
  }),
  (error) => error?.message === expectedFailure && !error.message.includes(String(address.port)),
);
const elapsedMs = Date.now() - startedAt;
assert.ok(elapsedMs >= 100 && elapsedMs < 2_000, `silent socket refusal took ${elapsedMs}ms`);
for (const socket of silentSockets) socket.destroy();
silentServer.close();
await once(silentServer, 'close');

process.stdout.write('OpenSpell report worker readiness invariants passed\n');
