import { Buffer } from 'node:buffer';
import { parentPort } from 'node:worker_threads';

if (parentPort === null) throw new Error('report JSON parser requires a parent port');

parentPort.once('message', (bytes) => {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    parentPort.postMessage({ ok: true, value });
  } catch {
    // JSON parser errors can quote source text. Return only a closed category.
    parentPort.postMessage({ ok: false });
  }
});
