import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RECOMMENDATION_WORKER_PUBLIC_KEYS = Object.freeze([
  'OPENSPELL_WORKER_REVISION',
  'PORT',
  'WORKER_CLAIM_ARMED',
  'WORKER_CLAIM_BATCH_SIZE',
  'WORKER_CLAIM_PROTOCOL',
  'WORKER_DEPLOYMENT_ROLE',
  'WORKER_ID',
  'WORKER_JOB_TYPES',
  'WORKER_MAX_CONCURRENT_JOBS',
  'WORKER_POLL_INTERVAL_MS',
  'WORKER_SHUTDOWN_DRAIN_MS',
].sort());

export async function resolveRecommendationWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment,
}) {
  for (const key of [
    'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'LWA_CLIENT_ID', 'LWA_CLIENT_SECRET',
    'SP_API_LWA_CLIENT_ID', 'SP_API_LWA_CLIENT_SECRET', 'ADS_CLIENT_ID', 'ADS_CLIENT_SECRET',
  ]) {
    if (environment[key] !== undefined) {
      throw new Error('OpenSpell recommendation worker received a provider setting');
    }
  }
  const releaseRevision = (await readFile(join(releaseRoot, 'REVISION'), 'utf8')).trim();
  if (!/^[0-9a-f]{40}$/u.test(releaseRevision)) {
    throw new Error('OpenSpell recommendation worker revision is invalid');
  }
  const claimArmed = environment.WORKER_CLAIM_ARMED;
  if (claimArmed !== '0' && claimArmed !== '1') {
    throw new Error('OpenSpell recommendation worker arming state is invalid');
  }
  const publicConfig = parsePublicConfig(
    await readFile(join(releaseRoot, claimArmed === '1' ? 'public-armed.conf' : 'public-standby.conf'), 'utf8'),
  );
  const expected = {
    OPENSPELL_WORKER_REVISION: releaseRevision,
    PORT: '3002',
    WORKER_CLAIM_ARMED: claimArmed,
    WORKER_CLAIM_BATCH_SIZE: '1',
    WORKER_CLAIM_PROTOCOL: 'recommendation-fenced-v1',
    WORKER_DEPLOYMENT_ROLE: 'evo-recommendation-lane',
    WORKER_ID: 'evo-recommendation-worker',
    WORKER_JOB_TYPES: 'recommendations.run',
    WORKER_MAX_CONCURRENT_JOBS: '1',
    WORKER_POLL_INTERVAL_MS: '1000',
    WORKER_SHUTDOWN_DRAIN_MS: '25000',
  };
  if (JSON.stringify(publicConfig) !== JSON.stringify(expected)) {
    throw new Error('OpenSpell recommendation worker public configuration is invalid');
  }
  for (const [key, value] of Object.entries(expected)) {
    if (environment[key] !== value) {
      throw new Error('OpenSpell recommendation worker process configuration differs from release');
    }
  }
  const databaseUrl = (
    await readFile(join(credentialDirectory, 'openspell-recommendation-worker-database-url'), 'utf8')
  ).trim();
  if (!/^postgres(?:ql)?:\/\/[^\s]{1,8180}$/u.test(databaseUrl)) {
    throw new Error('OpenSpell recommendation worker database credential is invalid');
  }
  return Object.freeze({ databaseUrl, releaseRevision, claimArmed: claimArmed === '1' });
}

export function parsePublicConfig(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.includes('\r')) {
      throw new Error('OpenSpell recommendation worker public configuration is malformed');
    }
    entries.push([line.slice(0, separator), line.slice(separator + 1)]);
  }
  if (
    entries.length !== RECOMMENDATION_WORKER_PUBLIC_KEYS.length
    || JSON.stringify(entries.map(([key]) => key).sort())
      !== JSON.stringify(RECOMMENDATION_WORKER_PUBLIC_KEYS)
  ) throw new Error('OpenSpell recommendation worker public key set is invalid');
  return Object.fromEntries(entries);
}
