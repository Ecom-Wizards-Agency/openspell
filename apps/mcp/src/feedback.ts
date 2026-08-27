/**
 * `submit_feedback` (WP-15).
 *
 * AdLabs exposes `submit_bug_report` over MCP, and it is the one write their
 * server allows; this is the same idea pointed at our own typed boards, so a model
 * that finds a bug while reading an account can file it where the team already
 * looks instead of describing it into a chat log nobody re-reads.
 *
 * Two properties make it safe to expose while every other write stays gated:
 *
 *  - It writes one row to one table, and that row is not advertising data. The
 *    worst outcome of a confused caller is a noisy board, not a changed bid.
 *  - It is audit-logged like every other call, by the same wrapper. The item
 *    itself records `actorType: 'mcp'` and the key id in its page context, so
 *    the board shows where it came from without an admin cross-referencing
 *    the log.
 *
 * The tool lives in its own file and is registered from `server.ts` in one
 * place: `apps/mcp` is WP-09's, and this addition is meant to be reviewable as
 * an addition. It imports only types from `server.ts`, so there is no import
 * cycle at runtime.
 */
import { z } from 'zod';
import { createFeedbackItem } from '@wizard-ads/db';
import type { FeedbackSeverity, FeedbackType } from '@wizard-ads/db';
import { ToolError } from './errors.js';
import type { ServerContext, ToolOutcome } from './server.js';

export const SUBMIT_FEEDBACK_TITLE = 'File a bug report or feature request';

export const SUBMIT_FEEDBACK_DESCRIPTION =
  'File a bug report or feature request against wizard-ads itself. Use it when a tool answers ' +
  'something that cannot be right, when a number disagrees with the account, or when a ' +
  'capability you needed is missing. Bugs are routed to the Bugs board; feature requests are ' +
  'routed to Roadmap. It changes nothing about any advertising account. Say what you did, what ' +
  'you expected and what happened, in the body.';

export const submitFeedbackInputSchema = {
  type: z.enum(['bug', 'feature']).describe('bug for something broken, feature for something missing'),
  title: z.string().min(1).max(200).describe('One line. What is wrong, or what is missing.'),
  body: z
    .string()
    .max(20_000)
    .default('')
    .describe('What you did, what you expected, what happened. Include the tool call that showed it.'),
  severity: z
    .enum(['low', 'medium', 'high', 'critical'])
    .optional()
    .describe('Bug reports only. Omit it on a feature request; the item is rejected otherwise.'),
};

export interface SubmitFeedbackArgs {
  type: FeedbackType;
  title: string;
  body: string;
  severity?: FeedbackSeverity;
}

export async function submitFeedback(
  context: ServerContext,
  args: SubmitFeedbackArgs,
): Promise<ToolOutcome> {
  if (args.type !== 'bug' && args.severity !== undefined) {
    throw new ToolError('invalid_argument', 'severity applies to a bug report, not to a request');
  }

  try {
    const item = await createFeedbackItem(context.handle, {
      orgId: context.scope.orgId,
      // No user is behind an MCP call. The key is, and it is in the context.
      authorId: null,
      type: args.type,
      title: args.title,
      body: args.body,
      severity: args.severity ?? null,
      pageContext: {
        actorType: 'mcp',
        keyId: context.keyId,
        route: null,
        profileId: null,
        appVersion: null,
      },
    });

    return {
      payload: {
        id: item.id,
        type: item.type,
        title: item.title,
        status: item.status,
        severity: item.severity,
        note:
          args.type === 'bug'
            ? 'Filed. It is visible now on /bugs. Nothing about any advertising account was changed.'
            : 'Filed. It is visible now on /roadmap. Nothing about any advertising account was changed.',
      },
      summary: { id: item.id, type: item.type, severity: item.severity ?? null },
    };
  } catch (error) {
    // A validation failure is the caller's to fix and deserves its reason; the
    // audit wrapper records either way.
    throw new ToolError('invalid_argument', error instanceof Error ? error.message : 'could not file feedback');
  }
}
