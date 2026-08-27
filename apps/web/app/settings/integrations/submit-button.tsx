'use client';

/** Prevent two submissions of the same provider/label while one is pending. */
import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '../../../src/ui/primitives';
import type { IntegrationProvider } from '@wizard-ads/db';

export function IntegrationSubmitButton({
  providerId,
  providerName,
}: {
  providerId: IntegrationProvider;
  providerName: string;
}): ReactNode {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      data-testid={`submit-integration-${providerId}`}
      disabled={pending}
      aria-disabled={pending}
    >
      {pending ? `Connecting ${providerName}…` : `Connect ${providerName}`}
    </Button>
  );
}
