/**
 * What each role may do, as data.
 *
 * Pure: no session, no database, no Next. That is what makes it testable on its
 * own and what stops the same rule being written twice, once in a page that
 * hides a control and once in the server action behind it. Hiding a button is
 * decoration; the action's check is the enforcement, and both read this table.
 *
 * The three capabilities are the ones WP-04 owns, straight from the brief:
 * viewer read-only, analyst edits targets, admin and owner toggle sync and
 * connect Amazon.
 */

export const ORG_ROLES = ['owner', 'admin', 'analyst', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export type Capability = 'read' | 'editTargets' | 'toggleSync' | 'manageConnection';

const CAPABILITIES: Record<OrgRole, readonly Capability[]> = {
  owner: ['read', 'editTargets', 'toggleSync', 'manageConnection'],
  admin: ['read', 'editTargets', 'toggleSync', 'manageConnection'],
  analyst: ['read', 'editTargets'],
  viewer: ['read'],
};

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

export function can(role: OrgRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return CAPABILITIES[role].includes(capability);
}

/** The roles that hold a capability. Used by tests and by the DB-policy mirror. */
export function rolesWith(capability: Capability): OrgRole[] {
  return ORG_ROLES.filter((role) => can(role, capability));
}

/** Thrown by `authorize`; the route layer turns it into a 403. */
export class Forbidden extends Error {
  readonly capability: Capability;
  constructor(capability: Capability) {
    super(`role is not permitted to ${capability}`);
    this.name = 'Forbidden';
    this.capability = capability;
  }
}

export function authorize(role: OrgRole | null | undefined, capability: Capability): void {
  if (!can(role, capability)) throw new Forbidden(capability);
}
