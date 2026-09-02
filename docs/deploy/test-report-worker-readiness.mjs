#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import process from 'node:process';
import { createDb } from '../../packages/db/src/client.ts';
import {
  REPORT_WORKER_FUNCTION_CONTRACTS,
  activateReportWorkerFencedAuthority,
  captureReportWorkerClaimCustody,
  verifyReportWorkerDatabaseReadiness,
  verifyReportWorkerFencedAuthority,
  verifyReportWorkerStartupGate,
  verifyFunctionCatalog,
} from './openspell-report-worker-readiness.mjs';

const expectedFailure = 'OpenSpell report worker database readiness failed';
const expectedAuthorityFailure = 'OpenSpell report worker claim authority proof failed';
const expectedActivationFailure = 'OpenSpell report worker claim authority activation failed';

function fakeHandle(contract, statements, {
  failWith,
  custodyRows = [],
  authorityRows = [{ protocol: 'fenced', epoch: '1' }],
  startupRows = [{ protocol: 'fenced', epoch: '1', unresolved: 0 }],
  activationRows = [{ decision: 'activated', epoch: '1', unresolved: 0 }],
  functionRows = readyFunctionRows,
} = {}) {
  const tag = async (parts) => {
    const text = parts.raw.join(' ').replaceAll(/\s+/gu, ' ').trim().toLowerCase();
    statements.push(text);
    if (failWith) throw new Error(failWith);
    if (text.includes('limit 0')) return [];
    if (text.includes('with required_functions')) return functionRows;
    if (text.includes('activate_report_worker_fenced_claims')) return activationRows;
    if (text.includes('get_report_worker_claim_authority') && text.includes('count(*)')) {
      return startupRows;
    }
    if (text.includes('get_report_worker_claim_authority')) return authorityRows;
    if (text.includes('where job_type = any')) return custodyRows;
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
  queue_status_type_ready: true,
  claim_token_column_ready: true,
  claim_token_index_ready: true,
  claim_token_acl_ready: true,
  authority_relation_ready: true,
  queue_read_ready: true,
  queue_type_access_ready: true,
};
const syntheticSources = Object.fromEntries(
  REPORT_WORKER_FUNCTION_CONTRACTS.map(({ key }) => [key, `synthetic function body: ${key}`]),
);
const syntheticContracts = REPORT_WORKER_FUNCTION_CONTRACTS.map(({ key, volatility }) => ({
  key,
  volatility,
  sourceHash: createHash('sha256').update(syntheticSources[key]).digest('hex'),
}));
const readyFunctionRows = syntheticContracts.map(({ key, volatility }) => ({
  function_key: key,
  owner_name: 'postgres',
  language_name: 'plpgsql',
  volatility,
  leakproof: false,
  security_definer: true,
  configuration: ['search_path=pg_catalog, public, pg_temp'],
  source: syntheticSources[key],
  signature_ready: true,
  acl_ready: true,
}));
const statements = [];
await verifyReportWorkerDatabaseReadiness({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, statements),
  functionContracts: syntheticContracts,
});
assert.equal(statements.length, 3);
assert.match(statements[0], /claim_token_column_ready/u);
assert.match(statements[0], /claim_token_acl_ready/u);
assert.match(statements[0], /report_worker_claim_authority/u);
assert.match(statements[1], /with required_functions/u);
assert.match(statements[1], /aclexplode/u);
assert.doesNotMatch(statements[1], /pg_get_functiondef/u);
assert.match(statements[2], /select id, claim_token from public\.sync_jobs limit 0/u);
assert.doesNotMatch(
  statements.join(' '),
  /(?:^|;)\s*(?:insert\s+into|update\s|delete\s+from|call\s)/u,
);

for (const key of Object.keys(ready)) {
  const refused = { ...ready, [key]: false };
  await assert.rejects(
    verifyReportWorkerDatabaseReadiness({
      databaseUrl: 'synthetic',
      createHandle: () => fakeHandle(refused, []),
      functionContracts: syntheticContracts,
    }),
    (error) => error?.message === expectedFailure,
  );
}

verifyFunctionCatalog(readyFunctionRows, syntheticContracts);
assert.equal(REPORT_WORKER_FUNCTION_CONTRACTS.length, 9);
assert.equal(new Set(REPORT_WORKER_FUNCTION_CONTRACTS.map(({ sourceHash }) => sourceHash)).size, 9);
assert.equal(
  REPORT_WORKER_FUNCTION_CONTRACTS.find(({ key }) => key === 'authority_get')?.volatility,
  's',
);
for (let index = 0; index < readyFunctionRows.length; index += 1) {
  const mutated = readyFunctionRows.map((row, rowIndex) => rowIndex === index
    ? { ...row, source: `${row.source} mutated` }
    : row);
  assert.throws(
    () => verifyFunctionCatalog(mutated, syntheticContracts),
    (error) => error?.message === expectedFailure,
  );
}
for (const field of [
  'owner_name', 'language_name', 'volatility', 'leakproof', 'security_definer',
  'configuration', 'source', 'signature_ready', 'acl_ready',
]) {
  const original = readyFunctionRows[0][field];
  const mutated = readyFunctionRows.map((row, index) => index === 0 ? {
    ...row,
    [field]: field === 'source' ? `${original} mutated`
      : field === 'configuration' ? ['search_path=public']
        : typeof original === 'boolean' ? !original : 'spoofed',
  } : row);
  assert.throws(
    () => verifyFunctionCatalog(mutated, syntheticContracts),
    (error) => error?.message === expectedFailure,
  );
}
assert.throws(
  () => verifyFunctionCatalog(readyFunctionRows.slice(1), syntheticContracts),
  (error) => error?.message === expectedFailure,
);
assert.throws(
  () => verifyFunctionCatalog([
    { ...readyFunctionRows[0] },
    { ...readyFunctionRows[0] },
    ...readyFunctionRows.slice(2),
  ], syntheticContracts),
  (error) => error?.message === expectedFailure,
);

const custodyRows = [{
  id: 'job-a',
  job_type: 'report.request',
  status: 'queued',
  attempts: 0,
  max_attempts: 5,
  run_after: '2026-09-02T00:00:00.000Z',
  claimed_by: null,
  claimed_at: null,
  claim_token: null,
  started_at: null,
  finished_at: null,
  last_error: null,
  created_at: '2026-09-02T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
}];
const custodyStatements = [];
const custody = await captureReportWorkerClaimCustody({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, custodyStatements, { custodyRows }),
});
const custodyAgain = await captureReportWorkerClaimCustody({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, [], { custodyRows }),
});
assert.deepEqual(custody, custodyAgain);
assert.equal(custody.unresolved, 0);
assert.match(custody.fingerprint, /^[0-9a-f]{64}$/u);
assert.equal(custodyStatements.length, 1);
assert.match(custodyStatements[0], /order by id/u);
assert.doesNotMatch(custodyStatements.join(' '), /\b(insert|update|delete|call)\b/u);
assert.doesNotMatch(JSON.stringify(custody), /job-a|report\.request/u);

const claimedCustody = await captureReportWorkerClaimCustody({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, [], {
    custodyRows: [{
      ...custodyRows[0],
      status: 'running',
      attempts: 1,
      claim_token: 'synthetic-token',
      claimed_by: 'synthetic-worker',
    }],
  }),
});
assert.equal(claimedCustody.unresolved, 1);
assert.notEqual(claimedCustody.fingerprint, custody.fingerprint);

const startupStatements = [];
const startup = await verifyReportWorkerStartupGate({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, startupStatements),
});
assert.deepEqual(startup, { protocol: 'fenced', epoch: '1', unresolved: 0 });
assert.equal(startupStatements.length, 1);
assert.match(startupStatements[0], /get_report_worker_claim_authority/u);
assert.match(startupStatements[0], /count\(\*\).*unresolved/u);
assert.doesNotMatch(startupStatements[0], /\b(insert|update|delete|call)\b/u);

for (const startupRows of [
  [{ protocol: 'legacy', epoch: '0', unresolved: 0 }],
  [{ protocol: 'fenced', epoch: '1', unresolved: 1 }],
  [{ protocol: 'fenced', epoch: '0', unresolved: 0 }],
  [{ protocol: 'fenced', epoch: '1', unresolved: 0, spoofed: true }],
  [],
  [
    { protocol: 'fenced', epoch: '1', unresolved: 0 },
    { protocol: 'fenced', epoch: '1', unresolved: 0 },
  ],
]) {
  await assert.rejects(
    verifyReportWorkerStartupGate({
      databaseUrl: 'synthetic',
      createHandle: () => fakeHandle(ready, [], { startupRows }),
    }),
    (error) => error?.message === expectedAuthorityFailure,
  );
}

const authority = await verifyReportWorkerFencedAuthority({
  databaseUrl: 'synthetic',
  createHandle: () => fakeHandle(ready, []),
});
assert.deepEqual(authority, { protocol: 'fenced', epoch: '1' });
for (const authorityRows of [
  [{ protocol: 'legacy', epoch: '0' }],
  [{ protocol: 'fenced', epoch: '-1' }],
  [{ protocol: 'fenced', epoch: '1', unresolved: 0 }],
]) {
  await assert.rejects(
    verifyReportWorkerFencedAuthority({
      databaseUrl: 'synthetic',
      createHandle: () => fakeHandle(ready, [], { authorityRows }),
    }),
    (error) => error?.message === expectedAuthorityFailure,
  );
}

for (const activationRows of [
  [{ decision: 'activated', epoch: '1', unresolved: 0 }],
  [{ decision: 'already_fenced', epoch: 2, unresolved: 0 }],
  [{ decision: 'unresolved', epoch: 0n, unresolved: 1 }],
]) {
  const result = await activateReportWorkerFencedAuthority({
    databaseUrl: 'synthetic',
    createHandle: () => fakeHandle(ready, [], { activationRows }),
  });
  assert.equal(typeof result.epoch, 'string');
}
for (const activationRows of [
  [{ decision: 'activated', epoch: '0', unresolved: 0 }],
  [{ decision: 'unresolved', epoch: '0', unresolved: 0 }],
  [{ decision: 'spoofed', epoch: '1', unresolved: 0 }],
  [{ decision: 'activated', epoch: '1', unresolved: 0, protocol: 'fenced' }],
]) {
  await assert.rejects(
    activateReportWorkerFencedAuthority({
      databaseUrl: 'synthetic',
      createHandle: () => fakeHandle(ready, [], { activationRows }),
    }),
    (error) => error?.message === expectedActivationFailure,
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
