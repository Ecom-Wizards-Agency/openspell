#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  classifyTransitionReadback,
  expectedTransition,
  parseAuthorityTuple,
  parseBrokerResult,
  validateCutoverEvidence,
} from './openspell-recommendation-worker-authority.mjs';
import {
  parsePublicConfig,
  resolveRecommendationWorkerRuntime,
} from './openspell-recommendation-worker-contract.mjs';
import { validateRecommendationHealthPayload } from './openspell-recommendation-worker-health.mjs';
import { runRecommendationWorkerMain } from './openspell-recommendation-worker-launch.mjs';

const deploy = dirname(fileURLToPath(import.meta.url));
const root = resolve(deploy, '../..');
const revisionA = 'a'.repeat(40);
const revisionB = 'b'.repeat(40);
const claimProtocolKey = `WORKER_CLAIM${'_PROTOCOL'}`;
const deploymentRoleKey = `WORKER_DEPLOYMENT${'_ROLE'}`;
const oldLegacy = { protocol: 'legacy', admission: 'legacy', epoch: 0, authorizedRevision: null };
const blockedLegacy = expectedTransition('block', oldLegacy, revisionA);
const fencedA = expectedTransition('activate', blockedLegacy, revisionA);
const scopedA = expectedTransition('authorize', fencedA, revisionA);
const blockedFencedA = { ...fencedA, admission: 'blocked' };
const fencedB = expectedTransition('rebind', blockedFencedA, revisionB);
assert.equal(classifyTransitionReadback(oldLegacy, blockedLegacy, blockedLegacy), 'committed');
assert.equal(classifyTransitionReadback(oldLegacy, blockedLegacy, oldLegacy), 'not_committed');
assert.equal(classifyTransitionReadback(oldLegacy, blockedLegacy, {
  ...blockedLegacy, epoch: blockedLegacy.epoch + 1,
}), 'ambiguous');
assert.equal(classifyTransitionReadback(blockedFencedA, fencedB, fencedB), 'committed');
assert.equal(classifyTransitionReadback(fencedA, scopedA, scopedA), 'committed');
assert.equal(classifyTransitionReadback(blockedFencedA, fencedB, {
  ...fencedB, authorizedRevision: revisionA,
}), 'ambiguous');
assert.throws(() => parseAuthorityTuple({ ...oldLegacy, token: 'not-allowed' }));
assert.throws(() => expectedTransition('rebind', blockedFencedA, revisionA));
parseBrokerResult({
  decision: 'rebound', ...fencedB, unresolved: 0,
}, 'rebind');
parseBrokerResult({
  decision: 'authorized', ...scopedA, unresolved: 0,
}, 'authorize');
assert.throws(() => parseBrokerResult({
  decision: 'rebound', ...fencedB, unresolved: 0, credential: 'not-allowed',
}, 'rebind'));
const preCutover = {
  ...fencedA,
  queuedJobs: 0,
  runningJobs: 0,
  tokenBearingJobs: 0,
  invalidActiveScopes: 0,
};
validateCutoverEvidence(preCutover, 'pre', revisionA);
validateCutoverEvidence({
  ...preCutover,
  ...scopedA,
  queuedJobs: 2,
  runningJobs: 1,
  tokenBearingJobs: 1,
}, 'post', revisionA);
assert.throws(() => validateCutoverEvidence({
  ...preCutover,
  invalidActiveScopes: 1,
}, 'pre', revisionA));
const armedBusyHealth = {
  status: 'ok',
  deployment: {
    revision: revisionA,
    role: 'evo-recommendation-lane',
    claimProtocol: 'recommendation-fenced-v1',
    jobTypes: ['recommendations.run'],
  },
  authority: {
    protocol: 'fenced', admission: 'scoped', epoch: 3, revisionMatches: true,
  },
  claimant: { ready: true, inFlight: 1, settlementFailure: false },
};
validateRecommendationHealthPayload(armedBusyHealth, revisionA, true);
assert.throws(() => validateRecommendationHealthPayload(armedBusyHealth, revisionA, false));
const unsafeRuntimeError = new Error('synthetic unresolved custody');
assert.equal(await runRecommendationWorkerMain({
  async main() { throw unsafeRuntimeError; },
  recommendationLaneExitCode(error) {
    assert.equal(error, unsafeRuntimeError);
    return 78;
  },
}, {}), 78);
assert.equal(await runRecommendationWorkerMain({
  async main() { throw new Error('synthetic transient failure'); },
  recommendationLaneExitCode() { return 1; },
}, {}), 1);

const healthEntryFixture = await mkdtemp(join(tmpdir(), 'openspell-recommendation-health-entry.'));
try {
  const linkedHealth = join(healthEntryFixture, 'health.mjs');
  await symlink(join(deploy, 'openspell-recommendation-worker-health.mjs'), linkedHealth);
  const result = spawnSync(process.execPath, [
    linkedHealth, 'http://127.0.0.1:3002/healthz', revisionA, '0', '1',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /health verification failed/u);
} finally {
  await rm(healthEntryFixture, { recursive: true, force: true });
}

const transitionFixture = await mkdtemp(join(tmpdir(), 'openspell-recommendation-transition.'));
try {
  const invocationCount = join(transitionFixture, 'invocations');
  const transitionScript = `
    source "$LIBRARY"
    recommendation_worker_authority_helper() { shift; /usr/local/bin/node "$HELPER" "$@"; }
    invoke_recommendation_authority_broker_once() {
      printf 'one\n' >>"$COUNT_FILE"
      return "$BROKER_STATUS"
    }
    read_recommendation_authority() { printf '%s\n' "$ACTUAL_TUPLE"; }
    transition_recommendation_authority fixture "$REVISION" block "$OLD_TUPLE"
  `;
  for (const [actual, status, expectedOutput, expectedStatus] of [
    [blockedLegacy, '2', 'committed', 0],
    [oldLegacy, '0', 'not_committed', 0],
    // Malformed, empty-success and oversized broker responses all normalize to
    // status 78. None may skip exact old/new tuple reconciliation.
    [blockedLegacy, '78', 'committed', 0],
    [blockedLegacy, '78', 'committed', 0],
    [blockedLegacy, '78', 'committed', 0],
    [{ ...blockedLegacy, epoch: 9 }, '0', 'ambiguous', 78],
  ]) {
    await writeFile(invocationCount, '');
    const result = spawnSync('bash', ['-c', transitionScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTUAL_TUPLE: JSON.stringify(actual),
        BROKER_STATUS: status,
        COUNT_FILE: invocationCount,
        HELPER: join(deploy, 'openspell-recommendation-worker-authority.mjs'),
        LIBRARY: join(deploy, 'recommendation-worker-evo-systemd-lib.sh'),
        OLD_TUPLE: JSON.stringify(oldLegacy),
        REVISION: revisionA,
      },
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.stdout.trim(), expectedOutput);
    assert.equal(await readFile(invocationCount, 'utf8'), 'one\n');
  }
} finally {
  await rm(transitionFixture, { recursive: true, force: true });
}

const configText = [
  `OPENSPELL_WORKER_REVISION=${revisionA}`,
  'PORT=3002',
  'WORKER_CLAIM_ARMED=0',
  'WORKER_CLAIM_BATCH_SIZE=1',
  `${claimProtocolKey}=recommendation-fenced-v1`,
  `${deploymentRoleKey}=evo-recommendation-lane`,
  'WORKER_ID=evo-recommendation-worker',
  'WORKER_JOB_TYPES=recommendations.run',
  'WORKER_MAX_CONCURRENT_JOBS=1',
  'WORKER_POLL_INTERVAL_MS=1000',
  'WORKER_SHUTDOWN_DRAIN_MS=25000',
].join('\n') + '\n';
const config = parsePublicConfig(configText);
assert.equal(config.WORKER_JOB_TYPES, 'recommendations.run');
assert.throws(() => parsePublicConfig(`${configText}EXTRA=value\n`));

const fixture = await mkdtemp(join(tmpdir(), 'openspell-recommendation-deploy.'));
try {
  await writeFile(join(fixture, 'REVISION'), `${revisionA}\n`);
  await writeFile(join(fixture, 'public-standby.conf'), configText);
  const credentials = join(fixture, 'credentials');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(credentials));
  await writeFile(
    join(credentials, 'openspell-recommendation-worker-database-url'),
    'postgresql://runtime@db.invalid/runtime\n',
  );
  const environment = { ...config };
  const runtime = await resolveRecommendationWorkerRuntime({
    releaseRoot: fixture, credentialDirectory: credentials, environment,
  });
  assert.equal(runtime.claimArmed, false);
  await assert.rejects(resolveRecommendationWorkerRuntime({
    releaseRoot: fixture,
    credentialDirectory: credentials,
    environment: { ...environment, ADS_CLIENT_ID: 'refused' },
  }));
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const shellFiles = [
  'install-recommendation-worker-evo-systemd.sh',
  'activate-recommendation-worker-evo-systemd.sh',
  'authorize-recommendation-scoped-admission-evo.sh',
  'rollback-recommendation-worker-evo-systemd.sh',
  'verify-recommendation-worker-evo-systemd.sh',
  'recommendation-worker-evo-systemd-lib.sh',
];
for (const file of shellFiles) execFileSync('bash', ['-n', join(deploy, file)]);
const installer = await readFile(join(deploy, shellFiles[0]), 'utf8');
assert.doesNotMatch(installer, /switch_recommendation_worker_link|systemctl\s+(?:start|stop|enable|disable|daemon-reload)/u);
assert.match(installer, /current, unit definitions, enablement, and service state were not changed/u);
const library = await readFile(join(deploy, shellFiles[5]), 'utf8');
assert.match(library, /invoke_recommendation_authority_broker_once/u);
assert.match(library, /reconcile_recommendation_transition/u);
assert.doesNotMatch(library, /systemctl (?:start|stop|restart|enable|disable) (?:wizard-ads-worker|openspell-report-worker)/u);

const modeFixture = await mkdtemp(join(tmpdir(), 'openspell-recommendation-modes.'));
try {
  await mkdir(join(modeFixture, 'bin'));
  await mkdir(join(modeFixture, 'systemd'));
  await writeFile(join(modeFixture, 'REVISION'), `${revisionA}\n`);
  await writeFile(join(modeFixture, 'bin', 'runtime.mjs'), 'export {};\n');
  await writeFile(join(modeFixture, 'systemd', 'worker.service'), '[Service]\n');
  await chmod(modeFixture, 0o777);
  await chmod(join(modeFixture, 'bin'), 0o600);
  await chmod(join(modeFixture, 'REVISION'), 0o777);
  execFileSync('bash', ['-c', 'source "$1"; normalize_recommendation_worker_artifact_modes "$2"',
    'mode-fixture', join(deploy, shellFiles[5]), modeFixture]);
  for (const directory of [modeFixture, join(modeFixture, 'bin'), join(modeFixture, 'systemd')]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  }
  for (const file of [
    join(modeFixture, 'REVISION'),
    join(modeFixture, 'bin', 'runtime.mjs'),
    join(modeFixture, 'systemd', 'worker.service'),
  ]) {
    assert.equal((await stat(file)).mode & 0o777, 0o644);
  }
} finally {
  await rm(modeFixture, { recursive: true, force: true });
}

for (const mode of ['standby', 'armed']) {
  const unit = await readFile(
    join(deploy, `openspell-recommendation-worker-${mode}.service`), 'utf8',
  );
  assert.match(unit, /LoadCredentialEncrypted=openspell-recommendation-worker-database-url:/u);
  assert.equal((unit.match(/LoadCredentialEncrypted=/gu) ?? []).length, 1);
  assert.doesNotMatch(unit, /ads|sp-api|lwa|amazon/i);
}

const graph = await bundledSourceGraph(
  join(root, 'apps/worker/src/recommendation-lane/main.ts'),
);
for (const path of graph) {
  assert.doesNotMatch(path, /packages\/(?:ads-api|sp-api|keepa-api|mrp-api|datadive-api)/u);
  assert.doesNotMatch(path, /apps\/worker\/src\/(?:ads-api|store|worker|schedules)\.ts$/u);
}
assert(graph.has('apps/worker/src/recommendation-cadence.ts'));
assert(graph.has('apps/worker/src/profile-calendar.ts'));
assert(!graph.has('apps/worker/src/schedules.ts'));

process.stdout.write(`recommendation worker deployment proofs passed (${graph.size} source inputs)\n`);

async function bundledSourceGraph(entry) {
  const directory = await mkdtemp(join(tmpdir(), 'openspell-recommendation-graph.'));
  try {
    const tsx = resolve(root, 'node_modules/tsx');
    const esbuild = resolve(dirname(await import('node:fs/promises').then(({ realpath }) => realpath(tsx))), 'esbuild/bin/esbuild');
    const output = join(directory, 'runtime.mjs');
    const metafile = join(directory, 'meta.json');
    execFileSync(esbuild, [
      entry, '--bundle', '--platform=node', '--format=esm', '--target=node22',
      `--outfile=${output}`, `--metafile=${metafile}`,
      `--alias:@wizard-ads/db/recommendation-worker=${join(root, 'packages/db/src/recommendation-worker.ts')}`,
      `--alias:@wizard-ads/core=${join(root, 'packages/core/src/index.ts')}`,
      `--alias:@wizard-ads/db=${join(root, 'packages/db/src/index.ts')}`,
      `--alias:@wizard-ads/shared=${join(root, 'packages/shared/src/index.ts')}`,
      `--alias:@wizard-ads/strategy=${join(root, 'packages/strategy/src/index.ts')}`,
    ]);
    const metadata = JSON.parse(await readFile(metafile, 'utf8'));
    return new Set(Object.keys(metadata.inputs).map((input) => {
      const normalized = relative(root, resolve(root, input)).replaceAll('\\', '/');
      if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error('bundle input escaped the repository');
      }
      return normalized;
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
