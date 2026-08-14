'use server';

/**
 * The two writes WP-04 owns, and the role check that guards each.
 *
 * The check is here, in the action, not in the page that renders the control.
 * A hidden button is a courtesy; a server action is the door. Both read the
 * same capability table (`src/auth/roles.ts`), so a viewer who replays this
 * request by hand gets the same refusal the UI implied.
 *
 * Percentages are the unit a human types and fractions are the unit doctrine
 * uses (`numeric(6,4)`), so the conversion happens once, here, rather than
 * being remembered at every call site.
 */
import { revalidatePath } from 'next/cache';
import { authorize } from '../../../src/auth/roles';
import { gateAction } from '../../../src/auth/guard';
import {
  setProfileSyncEnabled,
  setProfilesSyncEnabled,
  updateProfileSchedule,
  updateProfileTargets,
} from '../../../src/data/profiles';

export async function saveTargets(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'editTargets');

  const profileId = requireId(formData.get('profileId'));
  await updateProfileTargets(handle, active.orgId, profileId, {
    targetAcos: percentToFraction(formData.get('targetAcos')),
    targetTotalAcos: percentToFraction(formData.get('targetTotalAcos')),
    goalLens: text(formData.get('goalLens')),
    monthlyBudget: money(formData.get('monthlyBudget')),
  });

  revalidatePath('/settings/profiles');
}

export async function toggleSync(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'toggleSync');

  const profileId = requireId(formData.get('profileId'));
  const enabled = formData.get('enabled') === '1';
  await setProfileSyncEnabled(handle, active.orgId, profileId, enabled);

  revalidatePath('/settings/profiles');
  revalidatePath('/sync-status');
}

/**
 * Turn sync on or off for every checked row at once.
 *
 * Same role gate as the per-row control, checked here regardless of what the
 * page rendered. The count of rows changed is verified against the count asked
 * for: a bulk action that touched fewer rows than were selected throws rather
 * than reporting a silent partial success.
 */
export async function bulkSetSync(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'toggleSync');

  const profileIds = formData
    .getAll('profileIds')
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (profileIds.length === 0) throw new Error('no profiles selected');
  const enabled = formData.get('enabled') === '1';

  const changed = await setProfilesSyncEnabled(handle, active.orgId, profileIds, enabled);
  if (changed !== profileIds.length) {
    throw new Error(`selected ${profileIds.length} profiles but changed ${changed}`);
  }

  revalidatePath('/settings/profiles');
  revalidatePath('/sync-status');
}

/**
 * Save one profile's timezone and preferred sync hour.
 *
 * Setting a timezone pins it against Amazon re-sync (the data layer flips
 * `timezone_locked`). The role gate is the same one sync toggling uses: when a
 * profile's numbers land is an operations decision, not an analyst one.
 */
export async function saveSchedule(formData: FormData): Promise<void> {
  const { handle, active } = await gateAction();
  authorize(active.role, 'toggleSync');

  const profileId = requireId(formData.get('profileId'));
  await updateProfileSchedule(handle, active.orgId, profileId, {
    timezone: text(formData.get('timezone')),
    preferredSyncHour: hour(formData.get('preferredSyncHour')),
  });

  revalidatePath('/settings/profiles');
  revalidatePath('/sync-status');
}

function requireId(value: FormDataEntryValue | null): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('no profile given');
  return value;
}

function text(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** `25` on screen is `0.2500` in the column. Empty clears the target. */
function percentToFraction(value: FormDataEntryValue | null): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 999) throw new Error('a target percentage must be between 0 and 999');
  return Number((parsed / 100).toFixed(4));
}

function money(value: FormDataEntryValue | null): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (parsed < 0) throw new Error('a budget cannot be negative');
  return Number(parsed.toFixed(2));
}

function number(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`${trimmed} is not a number`);
  return parsed;
}

/** An hour of the day. Empty clears the preference; anything else must be 0–23. */
function hour(value: FormDataEntryValue | null): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
    throw new Error('a preferred sync hour must be a whole number between 0 and 23');
  }
  return parsed;
}
