const FULL_GIT_REVISION = /^[0-9a-f]{40}$/;

export interface PublicRevisionInputs {
  vercelGitCommitSha?: string | undefined;
  openspellAppVersion?: string | undefined;
  legacyAppVersion?: string | undefined;
}

export interface PublicWebHealth {
  product: 'OpenSpell';
  status: 'ready';
  revision: string | null;
}

/**
 * Release verification needs one unambiguous Git object id. Short hashes and
 * decorative version labels are intentionally refused because neither can
 * prove which source tree produced an immutable deployment.
 */
export function normalizePublicGitRevision(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  return FULL_GIT_REVISION.test(normalized) ? normalized : null;
}

export function resolvePublicGitRevision(input: PublicRevisionInputs): string | null {
  const supplied = [
    input.vercelGitCommitSha,
    input.openspellAppVersion,
    input.legacyAppVersion,
  ].find((value) => value !== undefined && value.trim() !== '');

  return normalizePublicGitRevision(supplied);
}

export function publicWebHealth(input: PublicRevisionInputs): PublicWebHealth {
  return {
    product: 'OpenSpell',
    status: 'ready',
    revision: resolvePublicGitRevision(input),
  };
}
