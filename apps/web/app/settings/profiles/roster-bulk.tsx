'use client';

/**
 * Multi-select for the roster, and the bulk sync action over the selection.
 *
 * The checkboxes are React state, not part of any HTML form. That is on purpose:
 * every row already carries its own small `saveTargets`/`saveSchedule` form, and
 * an outer `<form>` wrapping the table to collect checkboxes would nest forms,
 * which is invalid HTML and behaves unpredictably. So the selection lives in a
 * client context, the bulk bar reads it, and the server action is called the
 * same optimistic way the per-row `SyncControl` calls its own — build a
 * `FormData`, append one `profileIds` per selected row, run it in a transition,
 * toast the outcome, and clear on success.
 *
 * The bulk bar keeps its own gate too: the server action re-checks `toggleSync`
 * regardless of what the page chose to render, so a viewer who reaches this code
 * still meets the same refusal.
 */
import { createContext, useContext, useMemo, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import { Button, Checkbox } from '../../../src/ui/primitives';
import { useToast } from '../../../src/ui/toast';

interface SelectionValue {
  selected: ReadonlySet<string>;
  toggle: (id: string) => void;
  setMany: (ids: readonly string[], on: boolean) => void;
  clear: () => void;
}

const SelectionContext = createContext<SelectionValue | null>(null);

function useRosterSelection(): SelectionValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('roster selection used outside its provider');
  return value;
}

export function RosterSelectionProvider({ children }: { children: ReactNode }): ReactNode {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const value = useMemo<SelectionValue>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      setMany: (ids, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function RowCheckbox({ profileId, label }: { profileId: string; label: string }): ReactNode {
  const { selected, toggle } = useRosterSelection();
  return (
    <Checkbox
      checked={selected.has(profileId)}
      onChange={() => toggle(profileId)}
      aria-label={`Select ${label}`}
      data-testid="row-select"
    />
  );
}

export function SelectAllCheckbox({ profileIds }: { profileIds: readonly string[] }): ReactNode {
  const { selected, setMany } = useRosterSelection();
  const allSelected = profileIds.length > 0 && profileIds.every((id) => selected.has(id));
  const someSelected = profileIds.some((id) => selected.has(id));
  // A native input rather than the `Checkbox` primitive: this one needs a ref to
  // set `indeterminate`, which is a DOM property with no HTML attribute and so is
  // not expressible through props.
  return (
    <input
      type="checkbox"
      className="wa-checkbox"
      checked={allSelected}
      ref={(el: HTMLInputElement | null) => {
        if (el) el.indeterminate = !allSelected && someSelected;
      }}
      onChange={() => setMany(profileIds, !allSelected)}
      aria-label="Select all profiles on this page"
      data-testid="row-select-all"
    />
  );
}

export function BulkSyncBar({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}): ReactNode {
  const { selected, clear } = useRosterSelection();
  const [pending, startTransition] = useTransition();
  const toast = useToast();
  const count = selected.size;

  function run(enabled: boolean): void {
    if (count === 0) return;
    const ids = [...selected];
    const form = new FormData();
    for (const id of ids) form.append('profileIds', id);
    form.set('enabled', enabled ? '1' : '0');

    startTransition(async () => {
      try {
        await action(form);
        toast.show(
          `Sync ${enabled ? 'on' : 'off'} for ${ids.length} profile${ids.length === 1 ? '' : 's'}. The scheduler picks them up on the next pass.`,
          'good',
        );
        clear();
      } catch (error) {
        toast.show(error instanceof Error ? error.message : 'Bulk sync could not be changed.', 'bad');
      }
    });
  }

  return (
    <div
      className="wa-toolbar"
      data-testid="bulk-bar"
      aria-live="polite"
      style={{ alignItems: 'center' }}
    >
      <span className="wa-hint" data-testid="bulk-count">
        {count === 0 ? 'No profiles selected' : `${count} selected`}
      </span>
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={count === 0 || pending}
        aria-busy={pending}
        data-testid="bulk-enable"
        onClick={() => run(true)}
      >
        Enable sync
      </Button>
      <Button
        type="button"
        size="sm"
        disabled={count === 0 || pending}
        aria-busy={pending}
        data-testid="bulk-disable"
        onClick={() => run(false)}
      >
        Disable sync
      </Button>
    </div>
  );
}
