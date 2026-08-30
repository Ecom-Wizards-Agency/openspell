import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  afterCallbacks: [] as Array<() => void | Promise<void>>,
  close: vi.fn(async () => {}),
  createDb: vi.fn(),
}));

vi.mock('@wizard-ads/db', () => ({
  connectionStringFromEnv: () => 'postgresql://example.test/wizard_ads',
  createDb: mocks.createDb,
}));

vi.mock('next/server', () => ({
  after: mocks.after,
}));

type DatabaseGlobal = typeof globalThis & {
  __wizardAdsDatabaseState?: unknown;
};

async function reloadDatabaseModule() {
  vi.resetModules();
  return import('./db');
}

describe('web database lifecycle', () => {
  afterEach(async () => {
    const module = await import('./db');
    await module.resetDatabase();
    delete (globalThis as DatabaseGlobal).__wizardAdsDatabaseState;
    mocks.createDb.mockReset();
    mocks.close.mockReset();
    mocks.after.mockReset();
    mocks.afterCallbacks.length = 0;
  });

  it('bounds a warm route runtime to one connection and releases it after every lease', async () => {
    const handle = { close: mocks.close };
    mocks.createDb.mockReturnValue(handle);
    mocks.after.mockImplementation((callback: () => void | Promise<void>) => {
      mocks.afterCallbacks.push(callback);
    });

    const firstModule = await reloadDatabaseModule();
    const first = firstModule.database();
    const secondModule = await reloadDatabaseModule();
    const second = secondModule.database();

    expect(first).toBe(handle);
    expect(second).toBe(handle);
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
    expect(mocks.createDb).toHaveBeenCalledWith({
      connectionString: 'postgresql://example.test/wizard_ads',
      idleTimeoutSeconds: 1,
      max: 1,
    });
    expect(mocks.afterCallbacks).toHaveLength(2);

    await mocks.afterCallbacks[0]?.();
    expect(mocks.close).not.toHaveBeenCalled();

    await mocks.afterCallbacks[1]?.();
    expect(mocks.close).toHaveBeenCalledTimes(1);

    const nextHandle = { close: vi.fn(async () => {}) };
    mocks.createDb.mockReturnValue(nextHandle);
    expect(secondModule.database()).toBe(nextHandle);
    expect(mocks.createDb).toHaveBeenCalledTimes(2);
  });

  it('memoises an unavailable database across module invalidation', async () => {
    mocks.createDb.mockImplementation(() => {
      throw new Error('synthetic unavailable database');
    });

    expect((await reloadDatabaseModule()).database()).toBeNull();
    expect((await reloadDatabaseModule()).database()).toBeNull();
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('falls back to idle release when there is no Next request lifecycle', async () => {
    const handle = { close: mocks.close };
    mocks.createDb.mockReturnValue(handle);
    mocks.after.mockImplementation(() => {
      throw new Error('synthetic no request scope');
    });

    const module = await reloadDatabaseModule();
    expect(module.database()).toBe(handle);
    expect(module.database()).toBe(handle);
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
    expect(mocks.createDb).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutSeconds: 1, max: 1 }),
    );
  });
});
