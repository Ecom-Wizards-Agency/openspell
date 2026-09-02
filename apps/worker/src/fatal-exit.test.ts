import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { terminateAfterFatalWorkerFailure } from './fatal-exit.js';

describe('fatal worker termination', () => {
  it('exits 78 after shutdown even while a transport handle remains referenced', async () => {
    const fixture = fileURLToPath(
      new URL('./test-fixtures/fatal-exit-with-handle.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('fatal worker did not terminate within 2 seconds'));
        }, 2_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );

    expect(result).toEqual({ code: 78, signal: null });
    expect(stdout).toContain('shutdown-complete { released: 0, unresolved: 1 }');
    expect(stderr).toContain("failureKind: 'custody_quarantined'");
    expect(`${stdout}\n${stderr}`).not.toContain('provider');
    expect(`${stdout}\n${stderr}`).not.toContain('token');
  });

  it('uses exit 1 only after a clean non-custody fatal shutdown', async () => {
    const order: string[] = [];
    const exit = vi.fn((code: number): never => {
      order.push(`exit:${code}`);
      throw new Error('synthetic process exit');
    });

    await expect(terminateAfterFatalWorkerFailure({
      failureKind: 'unexpected',
      custodyFailure: false,
      shutdown: async () => {
        order.push('shutdown');
        return { released: 0, unresolved: 0 };
      },
      logger: { error: () => undefined },
      exit,
    })).rejects.toThrow('synthetic process exit');
    expect(order).toEqual(['shutdown', 'exit:1']);
  });
});
