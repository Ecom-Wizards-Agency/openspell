#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertLegacyReportWorkerRetired(text) {
  const entries = new Map();
  for (const line of text.trimEnd().split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('legacy worker state is unavailable');
    const key = line.slice(0, separator);
    if (entries.has(key)) throw new Error('legacy worker state is unavailable');
    entries.set(key, line.slice(separator + 1));
  }
  const keys = [...entries.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(['ActiveState', 'LoadState', 'UnitFileState'])) {
    throw new Error('legacy worker state is unavailable');
  }
  const absent = entries.get('LoadState') === 'not-found'
    && entries.get('ActiveState') === 'inactive'
    && entries.get('UnitFileState') === '';
  const retired = entries.get('LoadState') === 'loaded'
    && entries.get('ActiveState') === 'inactive'
    && entries.get('UnitFileState') === 'disabled';
  if (!absent && !retired) throw new Error('legacy worker is not inactive and disabled');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    assertLegacyReportWorkerRetired(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.stderr.write('legacy report worker retirement could not be proven\n');
    process.exit(1);
  }
}
