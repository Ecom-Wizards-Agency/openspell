/**
 * The feedback routes' error mapping.
 *
 * WP-08's `errorResponse` already turns an auth error into its status and a
 * "not found" into a 404, which is most of what these routes need. The one case
 * it cannot know about is an edit refused because the item has been triaged or
 * belongs to someone else: that is an authorization answer, not a malformed
 * request, and answering 400 would tell the caller to change their input when
 * the input was fine.
 */
import { FeedbackNotEditable } from '@wizard-ads/db';
import { errorResponse } from '../server/request-context';

export function feedbackErrorResponse(error: unknown): Response {
  if (error instanceof FeedbackNotEditable) {
    return Response.json({ error: error.message }, { status: 403 });
  }
  return errorResponse(error);
}

/** Read a known string off an unknown JSON body, or undefined. */
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
