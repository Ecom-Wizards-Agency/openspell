'use server';

/**
 * One-time credential writes for `/settings/integrations`.
 *
 * The server action is the authorization boundary: the page hiding a form is
 * only presentation. A credential is passed directly to the Vault RPC, never
 * returned, logged, copied into an error, or persisted in a web-owned column.
 */
import { revalidatePath } from 'next/cache';
import {
  INTEGRATION_PROVIDERS,
  createIntegrationConnection,
  listIntegrationConnections,
  revokeIntegrationSecret,
  setIntegrationConnectionStatus,
  storeIntegrationSecret,
} from '@wizard-ads/db';
import type { IntegrationProvider } from '@wizard-ads/db';
import { authorize } from '../../../src/auth/roles';
import { gateAction } from '../../../src/auth/guard';
import { currentUser } from '../../../src/auth/session';

const SETTINGS_PATH = '/settings/integrations';

export async function connectIntegration(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'manageConnection');

  const user = await currentUser();
  if (!user) throw new Error('not signed in');

  const provider = requireProvider(formData.get('provider'));
  const label = optionalLabel(formData.get('label')) ?? 'Default';
  const value = requireSecret(formData.get('secret'));
  const connection = await createIntegrationConnection(handle, {
    orgId: active.orgId,
    provider,
    label,
    connectedBy: user.id,
  });

  try {
    await storeIntegrationSecret(handle, connection.id, value);
  } catch {
    // Never persist or throw a provider/Vault message that could quote the
    // submitted value. The row remains visible in an actionable error state.
    await setIntegrationConnectionStatus(handle, {
      orgId: active.orgId,
      connectionId: connection.id,
      status: 'error',
      lastError: 'The credential could not be stored in Vault.',
    });
    throw new Error('The integration could not be connected.');
  }

  revalidatePath(SETTINGS_PATH);
}

export async function revokeIntegration(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'manageConnection');

  const connectionId = requireId(formData.get('connectionId'));
  const owned = (await listIntegrationConnections(handle, active.orgId)).some(
    (connection) => connection.id === connectionId,
  );
  if (!owned) throw new Error('Integration connection not found');

  await revokeIntegrationSecret(handle, connectionId);
  revalidatePath(SETTINGS_PATH);
}

function requireProvider(value: FormDataEntryValue | null): IntegrationProvider {
  if (
    typeof value !== 'string' ||
    !(INTEGRATION_PROVIDERS as readonly string[]).includes(value)
  ) {
    throw new Error('Unknown integration provider');
  }
  return value as IntegrationProvider;
}

function requireId(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('No integration connection given');
  }
  return value;
}

function optionalLabel(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label.length === 0 ? null : label;
}

function requireSecret(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Enter an API credential');
  }
  return value;
}
