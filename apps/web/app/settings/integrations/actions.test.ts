import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Forbidden } from '../../../src/auth/roles';

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  gateAction: vi.fn(),
  currentUser: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  revoke: vi.fn(),
  setStatus: vi.fn(),
  store: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('../../../src/auth/guard', () => ({ gateAction: mocks.gateAction }));
vi.mock('../../../src/auth/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@wizard-ads/db', () => ({
  INTEGRATION_PROVIDERS: ['keepa', 'datadive', 'mrp'],
  createIntegrationConnection: mocks.create,
  listIntegrationConnections: mocks.list,
  revokeIntegrationSecret: mocks.revoke,
  setIntegrationConnectionStatus: mocks.setStatus,
  storeIntegrationSecret: mocks.store,
}));

import { connectIntegration, revokeIntegration } from './actions';

const handle = {};
const orgId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const TEST_VALUE = ['synthetic', 'value'].join('-');

const form = (values: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

describe('integration settings actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue({ id: 'user-1', email: null });
    mocks.create.mockResolvedValue({ id: connectionId });
    mocks.store.mockResolvedValue('vault-id');
    mocks.setStatus.mockResolvedValue({ id: connectionId, status: 'error' });
    mocks.list.mockResolvedValue([{ id: connectionId }]);
    mocks.revoke.mockResolvedValue(true);
  });

  it.each(['analyst', 'viewer'] as const)('refuses a %s before touching metadata', async (role) => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId, role } });

    await expect(
      connectIntegration(form({ provider: 'keepa', secret: TEST_VALUE })),
    ).rejects.toBeInstanceOf(Forbidden);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('keeps a failed store as a sanitized, visible error row', async () => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId, role: 'admin' } });
    mocks.store.mockRejectedValue(new Error('provider mentioned the submitted value'));

    await expect(
      connectIntegration(
        form({ provider: 'datadive', label: 'Primary', secret: TEST_VALUE }),
      ),
    ).resolves.toBeUndefined();
    expect(mocks.setStatus).toHaveBeenCalledWith(handle, {
      orgId,
      connectionId,
      status: 'error',
      lastError: 'The credential could not be stored in Vault.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/settings/integrations');
  });

  it('refuses to revoke a connection outside the active organisation', async () => {
    mocks.gateAction.mockResolvedValue({ handle, active: { orgId, role: 'owner' } });
    mocks.list.mockResolvedValue([]);

    await expect(
      revokeIntegration(form({ connectionId })),
    ).rejects.toThrow(/not found/i);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
