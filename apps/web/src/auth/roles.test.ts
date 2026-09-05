/**
 * The capability table, asserted as a table.
 *
 * Written out in full rather than derived, because a test that computes the
 * expected answer from the same structure it is testing proves only that the
 * structure equals itself. If a row here changes, someone changed what a role
 * may do, and that should be visible in a diff.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authorize, can, Forbidden, ORG_ROLES, isOrgRole, rolesWith } from './roles';
import type { Capability, OrgRole } from './roles';

const EXPECTED: Record<OrgRole, Record<Capability, boolean>> = {
  owner: {
    read: true,
    editTargets: true,
    toggleSync: true,
    manageConnection: true,
    manageMembers: true,
    triageFeedback: true,
    manageExperiments: true,
    exportBatches: true,
    applyAmazonChanges: true,
  },
  admin: {
    read: true,
    editTargets: true,
    toggleSync: true,
    manageConnection: true,
    manageMembers: true,
    triageFeedback: true,
    manageExperiments: true,
    exportBatches: true,
    applyAmazonChanges: true,
  },
  analyst: {
    read: true,
    editTargets: true,
    toggleSync: false,
    manageConnection: false,
    manageMembers: false,
    triageFeedback: false,
    manageExperiments: true,
    exportBatches: false,
    applyAmazonChanges: false,
  },
  viewer: {
    read: true,
    editTargets: false,
    toggleSync: false,
    manageConnection: false,
    manageMembers: false,
    triageFeedback: false,
    manageExperiments: false,
    exportBatches: false,
    applyAmazonChanges: false,
  },
};

describe('org roles', () => {
  it.each(ORG_ROLES)('%s has exactly the documented capabilities', (role) => {
    for (const [capability, allowed] of Object.entries(EXPECTED[role])) {
      expect({ role, capability, allowed: can(role, capability as Capability) }).toEqual({
        role,
        capability,
        allowed,
      });
    }
  });

  it('grants nothing to a missing role', () => {
    expect(can(null, 'read')).toBe(false);
    expect(can(undefined, 'editTargets')).toBe(false);
  });

  it('lists the roles behind each capability', () => {
    expect(rolesWith('toggleSync')).toEqual(['owner', 'admin']);
    expect(rolesWith('editTargets')).toEqual(['owner', 'admin', 'analyst']);
    expect(rolesWith('manageConnection')).toEqual(['owner', 'admin']);
    expect(rolesWith('manageMembers')).toEqual(['owner', 'admin']);
    expect(rolesWith('triageFeedback')).toEqual(['owner', 'admin']);
    expect(rolesWith('exportBatches')).toEqual(['owner', 'admin']);
    expect(rolesWith('applyAmazonChanges')).toEqual(['owner', 'admin']);
  });

  it('keeps manageMembers aligned with every org_members write policy', () => {
    const tenancy = readFileSync(
      new URL('../../../../supabase/migrations/20260813120100_tenancy.sql', import.meta.url),
      'utf8',
    );
    const policyRoles = [
      ...tenancy.matchAll(
        /create policy org_members_(?:insert|update|delete)[\s\S]*?array\[([^\]]+)]/g,
      ),
    ].map((match) =>
      (match[1] ?? '')
        .split(',')
        .map((role) => role.trim().replaceAll("'", '')),
    );

    expect(policyRoles).toHaveLength(3);
    for (const roles of policyRoles) expect(rolesWith('manageMembers')).toEqual(roles);
  });

  it('recognises only real roles', () => {
    expect(isOrgRole('analyst')).toBe(true);
    expect(isOrgRole('superuser')).toBe(false);
    expect(isOrgRole(null)).toBe(false);
  });

  it('throws Forbidden, carrying the capability that was refused', () => {
    expect(() => authorize('viewer', 'editTargets')).toThrow(Forbidden);
    try {
      authorize('analyst', 'toggleSync');
      expect.unreachable('analyst must not toggle sync');
    } catch (error) {
      expect(error).toBeInstanceOf(Forbidden);
      expect((error as Forbidden).capability).toBe('toggleSync');
    }
    expect(() => authorize('admin', 'toggleSync')).not.toThrow();
  });
});
