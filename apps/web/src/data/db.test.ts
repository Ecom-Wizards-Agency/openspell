import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  createDb: vi.fn(),
}));

vi.mock('@wizard-ads/db', () => ({
  connectionStringFromEnv: () => 'postgresql://example.test/wizard_ads',
  createDb: mocks.createDb,
}));

type DatabaseGlobal = typeof globalThis & {
  __wizardAdsDatabaseState?: unknown;
};

async function reloadDatabaseModule() {
  vi.resetModules();
  return import('./db');
}

describe('development database pool cache', () => {
  afterEach(async () => {
    const module = await import('./db');
    await module.resetDatabase();
    delete (globalThis as DatabaseGlobal).__wizardAdsDatabaseState;
    mocks.createDb.mockReset();
    mocks.close.mockReset();
  });

  it('reuses one handle across module invalidation and closes it once', async () => {
    const handle = { close: mocks.close };
    mocks.createDb.mockReturnValue(handle);

    const firstModule = await reloadDatabaseModule();
    const first = firstModule.database();
    const secondModule = await reloadDatabaseModule();
    const second = secondModule.database();

    expect(first).toBe(handle);
    expect(second).toBe(handle);
    expect(mocks.createDb).toHaveBeenCalledTimes(1);

    await secondModule.resetDatabase();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('memoises an unavailable database across module invalidation', async () => {
    mocks.createDb.mockImplementation(() => {
      throw new Error('synthetic unavailable database');
    });

    expect((await reloadDatabaseModule()).database()).toBeNull();
    expect((await reloadDatabaseModule()).database()).toBeNull();
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
  });
});
