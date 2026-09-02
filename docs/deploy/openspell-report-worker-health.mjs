#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const [url, expectedRevision, rawAttempts = '1'] = process.argv.slice(2);
const attempts = Number(rawAttempts);
const expectedJobTypes = [
  'creative.sync',
  'report.request',
  'report.poll',
  'report.fetch',
];

if (!url || !/^https?:\/\//u.test(url)) {
  process.stderr.write('OpenSpell report worker health URL is invalid\n');
  process.exit(2);
}
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(expectedRevision ?? '')) {
  process.stderr.write('OpenSpell report worker expected revision must be a full Git object id\n');
  process.exit(2);
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 240) {
  process.stderr.write('OpenSpell report worker health attempts must be between 1 and 240\n');
  process.exit(2);
}

async function probe() {
  const response = await globalThis.fetch(url, {
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(5_000),
  });
  if (!response.body) throw new Error('health endpoint returned no body');
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of response.body) {
    bodyBytes += chunk.byteLength;
    if (bodyBytes > 65_536) throw new Error('response exceeded the health payload cap');
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks, bodyBytes).toString('utf8'));
  if (!response.ok) throw new Error('health endpoint was not ready');
  if (
    payload?.status !== 'ok'
    || payload?.worker?.stopping !== false
    || typeof payload?.worker?.running !== 'number'
    || payload.worker.running < 0
    || payload?.worker?.settlementFailure !== null
    || payload?.deployment?.revision !== expectedRevision
    || payload?.deployment?.role !== 'evo-report-lane'
    || payload?.deployment?.claimProtocol !== 'fenced'
    || JSON.stringify(payload?.deployment?.jobTypes) !== JSON.stringify(expectedJobTypes)
    || payload?.components?.marketingStream?.enabled !== false
  ) {
    throw new Error('health revision, role, protocol, claim set, or readiness did not match');
  }
}

let failure = 'health endpoint was unavailable';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await probe();
    process.stdout.write(`OpenSpell report worker health verified at revision ${expectedRevision}\n`);
    process.exit(0);
  } catch (error) {
    failure = error instanceof Error ? error.message : 'health probe failed';
    if (attempt < attempts) await delay(500);
  }
}

process.stderr.write(`OpenSpell report worker health verification failed: ${failure}\n`);
process.exit(1);
