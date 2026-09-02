#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_INPUT_BYTES = 8_192;
const REVISION = /^[0-9a-f]{40}$/u;
const AUTHORITY_KEYS = ['admission', 'authorizedRevision', 'epoch', 'protocol'];
const BROKER_KEYS = [...AUTHORITY_KEYS, 'decision', 'unresolved'].sort();
const EVIDENCE_KEYS = [
  ...AUTHORITY_KEYS,
  'invalidActiveScopes',
  'queuedJobs',
  'runningJobs',
  'tokenBearingJobs',
].sort();

export function parseAuthorityTuple(value) {
  assertExactObject(value, AUTHORITY_KEYS);
  if (!['legacy', 'fenced'].includes(value.protocol)
    || !['legacy', 'blocked', 'scoped'].includes(value.admission)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0
    || (value.authorizedRevision !== null && !REVISION.test(value.authorizedRevision))) {
    throw new Error('recommendation authority tuple is invalid');
  }
  return Object.freeze({
    protocol: value.protocol,
    admission: value.admission,
    epoch: value.epoch,
    authorizedRevision: value.authorizedRevision,
  });
}

export function expectedTransition(operation, oldValue, revision) {
  const oldTuple = parseAuthorityTuple(oldValue);
  if (!REVISION.test(revision ?? '')) throw new Error('transition revision is invalid');
  if (operation === 'block') {
    if (oldTuple.admission === 'blocked') return oldTuple;
    return Object.freeze({ ...oldTuple, admission: 'blocked', epoch: nextEpoch(oldTuple.epoch) });
  }
  if (operation === 'activate') {
    if (oldTuple.protocol !== 'legacy' || oldTuple.admission !== 'blocked') {
      throw new Error('activation source tuple is invalid');
    }
    return Object.freeze({
      protocol: 'fenced', admission: 'blocked', epoch: nextEpoch(oldTuple.epoch),
      authorizedRevision: revision,
    });
  }
  if (operation === 'rebind') {
    if (oldTuple.protocol !== 'fenced' || oldTuple.admission !== 'blocked'
      || oldTuple.authorizedRevision === revision) {
      throw new Error('rebind source tuple is invalid');
    }
    return Object.freeze({
      ...oldTuple, epoch: nextEpoch(oldTuple.epoch), authorizedRevision: revision,
    });
  }
  if (operation === 'authorize') {
    if (oldTuple.protocol !== 'fenced' || oldTuple.admission !== 'blocked'
      || oldTuple.authorizedRevision !== revision) {
      throw new Error('scoped admission source tuple is invalid');
    }
    return Object.freeze({
      ...oldTuple, admission: 'scoped', epoch: nextEpoch(oldTuple.epoch),
    });
  }
  throw new Error('transition operation is invalid');
}

export function classifyTransitionReadback(oldValue, newValue, actualValue) {
  const oldTuple = parseAuthorityTuple(oldValue);
  const newTuple = parseAuthorityTuple(newValue);
  const actualTuple = parseAuthorityTuple(actualValue);
  if (sameTuple(actualTuple, newTuple)) return 'committed';
  if (sameTuple(actualTuple, oldTuple)) return 'not_committed';
  return 'ambiguous';
}

export function parseBrokerResult(value, operation) {
  assertExactObject(value, BROKER_KEYS);
  parseAuthorityTuple({
    protocol: value.protocol,
    admission: value.admission,
    epoch: value.epoch,
    authorizedRevision: value.authorizedRevision,
  });
  if (!Number.isSafeInteger(value.unresolved) || value.unresolved < 0) {
    throw new Error('authority broker result is invalid');
  }
  const decisions = {
    block: ['blocked', 'already_blocked', 'stale_epoch'],
    activate: [
      'activated', 'already_fenced', 'stale_epoch', 'revision_conflict',
      'admission_not_blocked', 'unresolved',
    ],
    rebind: ['rebound', 'stale_epoch', 'authority_mismatch', 'unresolved'],
    authorize: [
      'authorized', 'already_scoped', 'stale_epoch', 'authority_mismatch',
      'admission_not_blocked', 'unresolved',
    ],
  };
  if (!decisions[operation]?.includes(value.decision)) {
    throw new Error('authority broker decision is invalid');
  }
  return Object.freeze(value);
}

export function validateCutoverEvidence(value, phase, revision) {
  assertExactObject(value, EVIDENCE_KEYS);
  const authority = parseAuthorityTuple(authorityFields(value));
  if ((phase !== 'pre' && phase !== 'post') || !REVISION.test(revision ?? '')) {
    throw new Error('cutover evidence expectation is invalid');
  }
  for (const key of ['queuedJobs', 'runningJobs', 'tokenBearingJobs', 'invalidActiveScopes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error('recommendation cutover evidence count is invalid');
    }
  }
  const admission = phase === 'pre' ? 'blocked' : 'scoped';
  if (authority.protocol !== 'fenced' || authority.admission !== admission
    || authority.authorizedRevision !== revision
    || value.invalidActiveScopes !== 0
    || value.runningJobs !== value.tokenBearingJobs
    || value.runningJobs > 1
    || (phase === 'pre' && (value.queuedJobs !== 0 || value.runningJobs !== 0))) {
    throw new Error('recommendation cutover evidence does not close');
  }
  return Object.freeze(value);
}

async function readAuthority(databaseUrl, revision) {
  const { RecommendationWorkerDatabase } = await import('@wizard-ads/db/recommendation-worker');
  const database = new RecommendationWorkerDatabase({
    connectionString: databaseUrl,
    workerId: 'evo-recommendation-worker',
    revision,
    statementTimeoutSeconds: 5,
  });
  try {
    return parseAuthorityTuple(await database.getAuthority());
  } finally {
    await database.close();
  }
}

async function readCutoverEvidence(databaseUrl, revision) {
  const { RecommendationWorkerDatabase } = await import('@wizard-ads/db/recommendation-worker');
  const database = new RecommendationWorkerDatabase({
    connectionString: databaseUrl,
    workerId: 'evo-recommendation-worker',
    revision,
    statementTimeoutSeconds: 5,
  });
  try {
    return validateCutoverEvidenceShape(await database.getCutoverEvidence());
  } finally {
    await database.close();
  }
}

async function runCommand() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === '--read') {
    const [revision] = args;
    if (!REVISION.test(revision ?? '')) throw new Error('authority readback failed');
    const databaseUrl = (await boundedStdin()).trim();
    const authority = await readAuthority(databaseUrl, revision);
    process.stdout.write(`${JSON.stringify(authority)}\n`);
    return;
  }
  if (mode === '--evidence') {
    const [revision] = args;
    if (!REVISION.test(revision ?? '')) throw new Error('evidence readback failed');
    const databaseUrl = (await boundedStdin()).trim();
    const evidence = await readCutoverEvidence(databaseUrl, revision);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return;
  }
  if (mode === '--expected') {
    const [operation, rawOld, revision] = args;
    const expected = expectedTransition(operation, JSON.parse(rawOld), revision);
    process.stdout.write(`${JSON.stringify(expected)}\n`);
    return;
  }
  if (mode === '--classify') {
    const [rawOld, rawNew] = args;
    const actual = JSON.parse(await boundedStdin());
    const decision = classifyTransitionReadback(JSON.parse(rawOld), JSON.parse(rawNew), actual);
    process.stdout.write(`${decision}\n`);
    if (decision === 'ambiguous') process.exitCode = 78;
    return;
  }
  if (mode === '--validate-broker') {
    const [operation] = args;
    parseBrokerResult(JSON.parse(await boundedStdin()), operation);
    return;
  }
  if (mode === '--validate-evidence') {
    const [phase, revision] = args;
    validateCutoverEvidence(JSON.parse(await boundedStdin()), phase, revision);
    return;
  }
  throw new Error('authority command is invalid');
}

function validateCutoverEvidenceShape(value) {
  assertExactObject(value, EVIDENCE_KEYS);
  parseAuthorityTuple(authorityFields(value));
  for (const key of ['queuedJobs', 'runningJobs', 'tokenBearingJobs', 'invalidActiveScopes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error('recommendation cutover evidence count is invalid');
    }
  }
  return Object.freeze(value);
}

async function boundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error('authority input is invalid');
    chunks.push(Buffer.from(chunk));
  }
  if (bytes === 0) {
    throw new Error('authority input is invalid');
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function sameTuple(left, right) {
  return left.protocol === right.protocol
    && left.admission === right.admission
    && left.epoch === right.epoch
    && left.authorizedRevision === right.authorizedRevision;
}

function authorityFields(value) {
  return {
    protocol: value.protocol,
    admission: value.admission,
    epoch: value.epoch,
    authorizedRevision: value.authorizedRevision,
  };
}

function nextEpoch(epoch) {
  const value = epoch + 1;
  if (!Number.isSafeInteger(value)) throw new Error('transition epoch is invalid');
  return value;
}

function assertExactObject(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error('recommendation authority object is invalid');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommand().catch(() => {
    process.stderr.write('OpenSpell recommendation authority operation failed\n');
    process.exitCode = 1;
  });
}
