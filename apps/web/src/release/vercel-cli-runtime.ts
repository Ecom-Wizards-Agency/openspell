import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPROVED_VERCEL_VERSION = '59.5.0';
const WEB_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SYSTEM_CURL = '/usr/bin/curl';

export interface VercelCliLaunch {
  readonly command: string;
  readonly argumentsPrefix: readonly string[];
  readonly systemPath: string;
}

export function lockedVercelCliLaunch(): VercelCliLaunch {
  const packageRoot = realpathSync(join(WEB_PACKAGE_ROOT, 'node_modules', 'vercel'));
  const manifestPath = realpathSync(join(packageRoot, 'package.json'));
  const manifest = vercelManifest(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.name !== 'vercel'
    || manifest.version !== APPROVED_VERCEL_VERSION
    || manifest.bin.vercel !== './dist/vc.js'
  ) {
    throw new Error('unapproved_vercel_package');
  }

  const entrypoint = realpathSync(join(packageRoot, manifest.bin.vercel));
  const entrypointRelative = relative(packageRoot, entrypoint);
  if (
    entrypointRelative === ''
    || entrypointRelative.startsWith('..')
    || isAbsolute(entrypointRelative)
    || !statSync(entrypoint).isFile()
  ) {
    throw new Error('unapproved_vercel_entrypoint');
  }

  const node = realpathSync(process.execPath);
  accessSync(node, fsConstants.X_OK);
  if (!statSync(node).isFile()) throw new Error('unapproved_node_runtime');

  return {
    command: node,
    argumentsPrefix: [entrypoint],
    systemPath: trustedSystemPath(),
  };
}

function trustedSystemPath(): string {
  const curl = realpathSync(SYSTEM_CURL);
  accessSync(curl, fsConstants.X_OK);
  const curlStat = statSync(curl);
  const directory = dirname(curl);
  const directoryStat = statSync(directory);
  if (
    !curlStat.isFile()
    || curlStat.uid !== 0
    || (curlStat.mode & 0o022) !== 0
    || directoryStat.uid !== 0
    || (directoryStat.mode & 0o022) !== 0
  ) {
    throw new Error('untrusted_system_curl');
  }
  return directory;
}

function vercelManifest(raw: string): {
  readonly name: unknown;
  readonly version: unknown;
  readonly bin: { readonly vercel: unknown };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid_vercel_manifest');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('invalid_vercel_manifest');
  }
  const record = parsed as Record<string, unknown>;
  const bin = record['bin'];
  if (typeof bin !== 'object' || bin === null || Array.isArray(bin)) {
    throw new Error('invalid_vercel_manifest');
  }
  return {
    name: record['name'],
    version: record['version'],
    bin: { vercel: (bin as Record<string, unknown>)['vercel'] },
  };
}
