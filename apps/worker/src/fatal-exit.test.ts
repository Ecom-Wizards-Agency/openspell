import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { terminateAfterFatalWorkerFailure } from './fatal-exit.js';

describe('fatal worker termination', () => {
  it('contains callback and later emitted audit errors until prompt exit 78', async () => {
    const fixture = fileURLToPath(
      new URL('./test-fixtures/fatal-exit-failing-audit.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('failed audit stream prevented bounded termination'));
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
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(stderr).toContain('shutdown-complete');
    expect(stderr).toContain('audit-error-event-observed');
    expect(stderr).not.toContain('uncaught-audit-error');
    expect(stderr).not.toContain('synthetic audit callback failure');
    expect(stderr).not.toContain('synthetic later audit event');
  });

  it('exits 78 after shutdown even while a transport handle remains referenced', async () => {
    const fixture = fileURLToPath(
      new URL('./test-fixtures/fatal-exit-with-handle.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(),
      env: { ...process.env, FATAL_AUDIT_TEST_MODE: 'release' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const ready = new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('audit-backpressure-ready')) resolve();
      });
    });
    await ready;
    // The pipe was genuinely backpressured before this test begins draining it.
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });

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
    expect(stdout).toContain('shutdown-complete\n');
    const audit = stdout.slice(stdout.indexOf('{"event":"report_worker_final_shutdown"'));
    expect(JSON.parse(audit.trim())).toEqual({
      event: 'report_worker_final_shutdown',
      trigger: 'fatal',
      exitCode: 78,
      released: 0,
      unresolved: 1,
      settlementFailure: 'custody_quarantined',
      evidenceAvailable: true,
    });
    expect(stderr).toContain("failureKind: 'custody_quarantined'");
    expect(`${stdout}\n${stderr}`).not.toContain('provider');
    expect(`${stdout}\n${stderr}`).not.toContain('token');
  });

  it('exits 78 by deadline when the final audit pipe never drains', async () => {
    const fixture = fileURLToPath(
      new URL('./test-fixtures/fatal-exit-with-handle.ts', import.meta.url),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: process.cwd(),
      env: { ...process.env, FATAL_AUDIT_TEST_MODE: 'never-drain' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    let stderr = '';
    const ready = new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.includes('audit-backpressure-ready')) resolve();
      });
    });
    await ready;
    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('audit deadline did not bound fatal worker termination'));
        }, 2_000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      },
    );
    child.stdout.destroy();

    expect(result).toEqual({ code: 78, signal: null });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
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
      auditStream: new Writable({
        write(_chunk, _encoding, callback) { callback(); },
      }),
    })).rejects.toThrow('synthetic process exit');
    expect(order).toEqual(['shutdown', 'exit:1']);
  });
});
