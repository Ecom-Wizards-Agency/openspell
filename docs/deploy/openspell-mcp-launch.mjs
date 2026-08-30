#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const credentialId = 'openspell-mcp-database-url';
const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
const releaseRoot = fileURLToPath(new URL('../', import.meta.url));

if (!releaseRoot.startsWith('/opt/openspell-mcp/')) {
  throw new Error('OpenSpell MCP launcher is outside the immutable release root');
}
if (!credentialDirectory) {
  throw new Error('systemd did not provide the OpenSpell MCP credential directory');
}

const releaseRevision = (await readFile(new URL('../REVISION', import.meta.url), 'utf8')).trim();
const runtimeRevision = process.env.WIZARD_ADS_MCP_REVISION ?? '';
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(releaseRevision)
  || runtimeRevision !== releaseRevision) {
  throw new Error('OpenSpell MCP release revision does not match its runtime configuration');
}

const databaseUrl = (await readFile(`${credentialDirectory}/${credentialId}`, 'utf8')).trim();
if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
  throw new Error('OpenSpell MCP database credential is invalid');
}

process.env.WIZARD_ADS_MCP_DATABASE_URL = databaseUrl;
try {
  await import(new URL('../src/bin/serve.ts', import.meta.url));
} finally {
  delete process.env.WIZARD_ADS_MCP_DATABASE_URL;
}
