'use client';

/**
 * The per-profile sync control.
 *
 * It used to be a button whose label was its own state — you read `off`, and
 * had to know that pressing the word "off" would turn it on. That is a toggle
 * pretending to be a status, and on a roster of two hundred rows it is a
 * genuinely dangerous control: the thing you clicked and the thing you meant are
 * one keystroke apart and nothing confirms which happened.
 *
 * So it is a select. The options *are* the states, the current one is selected,
 * choosing it says what it did, and choosing the one already chosen does
 * nothing. Three properties the button had none of.
 *
 * Optimistic on purpose: the row shows the new state immediately and reverts if
 * the server refuses. The refusal it is most likely to meet is the role gate —
 * `toggleSync` re-checks `toggleSync` capability server-side regardless of what
 * this page chose to render — so a revert here is a real answer, not a glitch,
 * and the toast says so.
 *
 * The server action is untouched: it still reads `profileId` and `enabled`, and
 * `enabled` is still `'1'` or `'0'`. What changed is that `'1'` now means "on"
 * rather than "whatever the opposite of the current state was".
 */
import { useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { Select } from '../../../src/ui/primitives';
import { useToast } from '../../../src/ui/toast';
import { toggleSync } from './actions';

export function SyncControl({
  profileId,
  profileLabel,
  enabled,
}: {
  profileId: string;
  profileLabel: string;
  enabled: boolean;
}): ReactNode {
  const [value, setValue] = useState(enabled ? '1' : '0');
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  return (
    <Select
      compact
      aria-label={`Sync for ${profileLabel}`}
      aria-busy={pending}
      data-testid="toggle-sync"
      style={{ width: '5.5rem' }}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        const previous = value;
        if (next === previous) return;
        setValue(next);

        const form = new FormData();
        form.set('profileId', profileId);
        form.set('enabled', next);

        startTransition(async () => {
          try {
            await toggleSync(form);
            toast.show(
              `Sync ${next === '1' ? 'on' : 'off'} — ${profileLabel}. The scheduler picks it up on the next pass.`,
              'good',
            );
          } catch (error) {
            setValue(previous);
            toast.show(
              error instanceof Error ? error.message : 'Sync could not be changed.',
              'bad',
            );
          }
        });
      }}
    >
      <option value="1">On</option>
      <option value="0">Off</option>
    </Select>
  );
}
