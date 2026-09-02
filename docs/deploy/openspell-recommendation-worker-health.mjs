#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function main() {
  const [rawUrl, expectedRevision, expectedArmed, rawAttempts = '1'] = process.argv.slice(2);
  const attempts = Number(rawAttempts);
  if (rawUrl !== 'http://127.0.0.1:3002/healthz') fail('health URL is not exact loopback', 2);
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision ?? '')) fail('revision is invalid', 2);
  if (expectedArmed !== '0' && expectedArmed !== '1') fail('arming state is invalid', 2);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 240) fail('attempt count is invalid', 2);
  const armed = expectedArmed === '1';

  async function probe() {
    const response = await globalThis.fetch(rawUrl, {
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(5_000),
    });
    if (!response.body) throw new Error('missing body');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16_384) throw new Error('oversized body');
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!response.ok) throw new Error('health response is not successful');
    validateRecommendationHealthPayload(payload, expectedRevision, armed);
  }

  let failure = 'unavailable';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probe();
      process.stdout.write(`OpenSpell recommendation worker health verified at revision ${expectedRevision}\n`);
      return;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'probe failed';
      if (attempt < attempts) await delay(500);
    }
  }
  fail(`health verification failed: ${failure}`, 1);
}

export function validateRecommendationHealthPayload(payload, expectedRevision, armed) {
  assertExactKeys(payload, ['authority', 'claimant', 'deployment', 'status']);
  assertExactKeys(payload.deployment, ['claimProtocol', 'jobTypes', 'revision', 'role']);
  assertExactKeys(payload.authority, ['admission', 'epoch', 'protocol', 'revisionMatches']);
  assertExactKeys(payload.claimant, ['inFlight', 'ready', 'settlementFailure']);
  if (payload.status !== (armed ? 'ok' : 'standby')
    || payload.deployment.revision !== expectedRevision
    || payload.deployment.role !== 'evo-recommendation-lane'
    || payload.deployment.claimProtocol !== 'recommendation-fenced-v1'
    || JSON.stringify(payload.deployment.jobTypes) !== '["recommendations.run"]'
    || !['legacy', 'fenced'].includes(payload.authority.protocol)
    || !['legacy', 'blocked', 'scoped'].includes(payload.authority.admission)
    || !Number.isSafeInteger(payload.authority.epoch) || payload.authority.epoch < 0
    || typeof payload.authority.revisionMatches !== 'boolean'
    || (armed
      ? payload.claimant.inFlight !== 0 && payload.claimant.inFlight !== 1
      : payload.claimant.inFlight !== 0)
    || payload.claimant.settlementFailure !== false
    || (armed && (payload.authority.protocol !== 'fenced'
      || payload.authority.revisionMatches !== true || payload.claimant.ready !== true))
    || (!armed && payload.claimant.ready !== false)) {
    throw new Error('health contract mismatch');
  }
}

function assertExactKeys(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error('health key set mismatch');
  }
}

function fail(message, code) {
  process.stderr.write(`OpenSpell recommendation worker ${message}\n`);
  process.exit(code);
}

const entryPath = process.argv[1];
const isMain = entryPath !== undefined
  && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
if (isMain) {
  void main();
}
