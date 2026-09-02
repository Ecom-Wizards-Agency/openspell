import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REPORT_WORKER_CLAIM_SET =
  'creative.sync,report.request,report.poll,report.fetch';
export const REPORT_WORKER_PUBLIC_KEYS = [
  'OPENSPELL_WORKER_REVISION',
  'WORKER_CLAIM_BATCH_SIZE',
  'WORKER_CLAIM_PROTOCOL',
  'WORKER_DEPLOYMENT_ROLE',
  'WORKER_JOB_TYPES',
  'WORKER_MAX_CONCURRENT_JOBS',
].sort();

export async function resolveReportWorkerRuntime({
  releaseRoot,
  credentialDirectory,
  environment,
}) {
  const releaseRevision = (await readFile(join(releaseRoot, 'REVISION'), 'utf8')).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(releaseRevision)) {
    throw new Error('OpenSpell report worker release revision is not a full Git object id');
  }

  const publicConfig = parsePublicConfig(
    await readFile(join(releaseRoot, 'public.conf'), 'utf8'),
  );
  if (
    publicConfig.OPENSPELL_WORKER_REVISION !== releaseRevision
    || publicConfig.WORKER_CLAIM_PROTOCOL !== 'fenced'
    || publicConfig.WORKER_DEPLOYMENT_ROLE !== 'evo-report-lane'
    || publicConfig.WORKER_JOB_TYPES !== REPORT_WORKER_CLAIM_SET
    || publicConfig.WORKER_CLAIM_BATCH_SIZE !== '1'
    || publicConfig.WORKER_MAX_CONCURRENT_JOBS !== '1'
  ) {
    throw new Error('OpenSpell report worker public configuration does not match its release');
  }
  for (const [key, value] of Object.entries(publicConfig)) {
    if (environment[key] !== value) {
      throw new Error('OpenSpell report worker process configuration differs from public.conf');
    }
  }

  const databaseUrl = (
    await readFile(join(credentialDirectory, 'openspell-report-worker-database-url'), 'utf8')
  ).trim();
  if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
    throw new Error('OpenSpell report worker database credential is invalid');
  }

  let adsApplication;
  try {
    adsApplication = JSON.parse(
      await readFile(
        join(credentialDirectory, 'openspell-report-worker-ads-application'),
        'utf8',
      ),
    );
  } catch {
    throw new Error('OpenSpell report worker Ads application credential is invalid');
  }
  const adsKeys = adsApplication
    && typeof adsApplication === 'object'
    && !Array.isArray(adsApplication)
    ? Object.keys(adsApplication).sort()
    : [];
  if (
    JSON.stringify(adsKeys) !== JSON.stringify(['clientId', 'clientSecret'])
    || !boundedString(adsApplication.clientId)
    || !boundedString(adsApplication.clientSecret)
  ) {
    throw new Error('OpenSpell report worker Ads application credential is invalid');
  }

  return {
    databaseUrl,
    lwaClientId: adsApplication.clientId,
    lwaClientSecret: adsApplication.clientSecret,
    releaseRevision,
  };
}

export function parsePublicConfig(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.includes('\r')) {
      throw new Error('OpenSpell report worker public configuration is malformed');
    }
    entries.push([line.slice(0, separator), line.slice(separator + 1)]);
  }
  if (
    entries.length !== REPORT_WORKER_PUBLIC_KEYS.length
    || JSON.stringify(entries.map(([key]) => key).sort())
      !== JSON.stringify(REPORT_WORKER_PUBLIC_KEYS)
  ) {
    throw new Error('OpenSpell report worker public configuration has an unexpected key set');
  }
  return Object.fromEntries(entries);
}

function boundedString(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 4096
    && value.trim() === value;
}
