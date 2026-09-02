#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { resolveRecommendationWorkerRuntime } from './openspell-recommendation-worker-contract.mjs';

export async function runRecommendationWorkerMain(module, environment) {
  if (typeof module?.main !== 'function' || typeof module?.recommendationLaneExitCode !== 'function') {
    throw new Error('recommendation worker runtime contract is invalid');
  }
  try {
    await module.main(environment);
    return 0;
  } catch (error) {
    const exitCode = module.recommendationLaneExitCode(error);
    return exitCode === 1 || exitCode === 78 ? exitCode : 1;
  }
}

async function launch() {
  const releaseRoot = fileURLToPath(new URL('../', import.meta.url));
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (!releaseRoot.startsWith('/opt/openspell-recommendation-worker/releases/')) {
    throw new Error('OpenSpell recommendation worker launcher is outside an immutable release');
  }
  if (!credentialDirectory) {
    throw new Error('systemd did not provide the recommendation worker credential directory');
  }
  const runtime = await resolveRecommendationWorkerRuntime({
    releaseRoot,
    credentialDirectory,
    environment: process.env,
  });
  process.env.DATABASE_URL = runtime.databaseUrl;
  process.env.WORKER_HEALTH_HOST = '127.0.0.1';
  try {
    const module = await import(new URL('./openspell-recommendation-worker-runtime.mjs', import.meta.url));
    process.exitCode = await runRecommendationWorkerMain(module, process.env);
  } finally {
    delete process.env.DATABASE_URL;
    delete process.env.WORKER_HEALTH_HOST;
  }
}

const entryPath = process.argv[1];
const isMain = entryPath !== undefined
  && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
if (isMain) {
  launch().catch(() => { process.exitCode = 1; });
}
