import { Buffer } from 'node:buffer';
import { parentPort } from 'node:worker_threads';

if (parentPort === null) throw new Error('report JSON parser requires a parent port');

let rows = null;
let offset = 0;
let maxRows = 0;
let maxBytes = 0;

function sendNextChunk() {
  if (rows === null) return;
  if (offset >= rows.length) {
    parentPort.postMessage({ kind: 'done', rowCount: rows.length });
    rows = null;
    return;
  }

  const start = offset;
  const chunk = [];
  let serializedBytes = 2;
  while (offset < rows.length && chunk.length < maxRows) {
    const row = rows[offset];
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (rowBytes > maxBytes) {
      parentPort.postMessage({ kind: 'row_limit' });
      rows = null;
      return;
    }
    const nextBytes = serializedBytes + rowBytes + (chunk.length === 0 ? 0 : 1);
    if (chunk.length > 0 && nextBytes > maxBytes) break;
    serializedBytes = nextBytes;
    chunk.push(row);
    rows[offset] = undefined;
    offset += 1;
  }
  parentPort.postMessage({ kind: 'rows', offset: start, rows: chunk });
}

parentPort.on('message', (message) => {
  if (message?.kind === 'start') {
    try {
      const value = JSON.parse(Buffer.from(message.bytes).toString('utf8'));
      if (!Array.isArray(value)) {
        parentPort.postMessage({ kind: 'not_array' });
        return;
      }
      if (!Number.isSafeInteger(message.maxRows) || message.maxRows < 1
        || !Number.isSafeInteger(message.maxBytes) || message.maxBytes < 1
        || !Number.isSafeInteger(message.maxTotalRows) || message.maxTotalRows < 1) {
        parentPort.postMessage({ kind: 'invalid_config' });
        return;
      }
      if (value.length > message.maxTotalRows) {
        parentPort.postMessage({ kind: 'row_count_limit' });
        return;
      }
      rows = value;
      maxRows = message.maxRows;
      maxBytes = message.maxBytes;
      sendNextChunk();
    } catch {
      // JSON parser errors can quote source text. Return only a closed category.
      parentPort.postMessage({ kind: 'invalid_json' });
    }
    return;
  }
  if (message?.kind === 'next') sendNextChunk();
});
