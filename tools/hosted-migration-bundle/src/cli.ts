#!/usr/bin/env node
import {
  buildHostedMigrationBundle,
  verifyHostedMigrationBundle,
} from './bundle.js';
import { BundleFailure } from './engine.js';

type Command =
  | {
      readonly operation: 'build';
      readonly historyWorkdir: string;
      readonly outputWorkdir: string;
      readonly sourceRevision: string;
    }
  | {
      readonly operation: 'verify';
      readonly bundleWorkdir: string;
      readonly sourceRevision: string;
      readonly mode: 'sealed' | 'cli-workdir';
    };

const BUILD_FLAGS = new Set(['--history-workdir', '--output-workdir', '--revision']);
const VERIFY_FLAGS = new Set(['--bundle-workdir', '--revision', '--mode']);

export function parseCommand(argv: readonly string[]): Command {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const operation = args[0];
  if (operation !== 'build' && operation !== 'verify') throw new BundleFailure('INVALID_ARGUMENT');
  const permitted = operation === 'build' ? BUILD_FLAGS : VERIFY_FLAGS;
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !permitted.has(flag) || values.has(flag)) {
      throw new BundleFailure('INVALID_ARGUMENT');
    }
    if (value.length === 0 || value.startsWith('--')) throw new BundleFailure('INVALID_ARGUMENT');
    values.set(flag, value);
  }
  if (values.size !== 3) throw new BundleFailure('INVALID_ARGUMENT');

  const sourceRevision = values.get('--revision');
  if (sourceRevision === undefined) throw new BundleFailure('INVALID_ARGUMENT');
  if (operation === 'build') {
    const historyWorkdir = values.get('--history-workdir');
    const outputWorkdir = values.get('--output-workdir');
    if (historyWorkdir === undefined || outputWorkdir === undefined) {
      throw new BundleFailure('INVALID_ARGUMENT');
    }
    return { operation, historyWorkdir, outputWorkdir, sourceRevision };
  }

  const bundleWorkdir = values.get('--bundle-workdir');
  const mode = values.get('--mode');
  if (bundleWorkdir === undefined || (mode !== 'sealed' && mode !== 'cli-workdir')) {
    throw new BundleFailure('INVALID_ARGUMENT');
  }
  return { operation, bundleWorkdir, sourceRevision, mode };
}

export async function run(argv: readonly string[]): Promise<number> {
  try {
    const command = parseCommand(argv);
    const evidence =
      command.operation === 'build'
        ? await buildHostedMigrationBundle(command)
        : await verifyHostedMigrationBundle(command);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof BundleFailure ? error.code : 'PUBLISH_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'error', code })}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
