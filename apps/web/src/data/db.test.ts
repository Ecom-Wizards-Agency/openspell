import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';

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

describe('web database lifecycle', () => {
  afterEach(async () => {
    const module = await import('./db');
    await module.resetDatabase();
    delete (globalThis as DatabaseGlobal).__wizardAdsDatabaseState;
    mocks.createDb.mockReset();
    mocks.close.mockReset();
  });

  it('bounds a warm route runtime to one idle-releasing connection across module loads', async () => {
    const handle = { close: mocks.close } as unknown as DbHandle;
    mocks.createDb.mockReturnValue(handle);

    const firstModule = await reloadDatabaseModule();
    const handles = [firstModule.database()];
    for (let index = 0; index < 30; index += 1) {
      handles.push((await reloadDatabaseModule()).database());
    }

    expect(handles).toHaveLength(31);
    expect(handles.every((candidate) => candidate === handle)).toBe(true);
    expect(mocks.createDb).toHaveBeenCalledTimes(1);
    expect(mocks.createDb).toHaveBeenCalledWith({
      connectionString: 'postgresql://example.test/wizard_ads',
      idleTimeoutSeconds: 1,
      max: 1,
    });

    await firstModule.resetDatabase();
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
