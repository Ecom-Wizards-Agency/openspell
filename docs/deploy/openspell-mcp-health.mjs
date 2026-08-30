#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const [url, expectedRevision, rawAttempts = '1'] = process.argv.slice(2);
const attempts = Number(rawAttempts);

if (!url || !/^https?:\/\//u.test(url)) {
  process.stderr.write('OpenSpell MCP health URL is invalid\n');
  process.exit(2);
}
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(expectedRevision ?? '')) {
  process.stderr.write('OpenSpell MCP expected revision must be a full Git object id\n');
  process.exit(2);
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 240) {
  process.stderr.write('OpenSpell MCP health attempts must be between 1 and 240\n');
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
    if (bodyBytes > 65_536) {
      throw new Error('response exceeded the health payload cap');
    }
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks, bodyBytes).toString('utf8'));
  if (!response.ok) throw new Error('health endpoint was not ready');
  if (
    payload?.status !== 'ready'
    || payload?.service !== 'openspell'
    || payload?.product !== 'OpenSpell'
    || payload?.revision !== expectedRevision
  ) {
    throw new Error('health identity or revision did not match');
  }
}

let failure = 'health endpoint was unavailable';
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await probe();
    process.stdout.write(`OpenSpell MCP health verified at revision ${expectedRevision}\n`);
    process.exit(0);
  } catch (error) {
    failure = error instanceof Error ? error.message : 'health probe failed';
    if (attempt < attempts) await delay(500);
  }
}

process.stderr.write(`OpenSpell MCP health verification failed: ${failure}\n`);
process.exit(1);
