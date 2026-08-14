/**
 * The experiment routes' error mapping and body helpers.
 *
 * WP-08's `errorResponse` already turns an auth error into its status and a
 * "not found" into a 404. The one case it cannot know about is a status move
 * that the lifecycle forbids: that is a conflict with the resource's current
 * state, not a malformed request, so it answers 409 rather than 400.
 */
import { ExperimentNotFound, InvalidExperimentTransition } from '@wizard-ads/db';
import { errorResponse } from '../server/request-context';

export function experimentErrorResponse(error: unknown): Response {
  if (error instanceof InvalidExperimentTransition) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ExperimentNotFound) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  return errorResponse(error);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse a comma-or-array list of ids into a clean string array, or undefined. */
export function idList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const cleaned = Array.from(
    new Set(raw.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim())),
  ).filter((entry) => entry !== '');
  return cleaned.length > 0 ? cleaned : undefined;
}
