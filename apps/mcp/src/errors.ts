/**
 * Errors that mean something specific to a caller.
 *
 * `ToolError` is the only kind a tool raises deliberately. It becomes an MCP
 * error result with a message a model can act on ("that profile is not in this
 * key's scope"), never a stack trace and never a database message: a Postgres
 * error string can carry a column list, and this server answers callers who are
 * outside the org boundary by construction.
 */

export type ToolErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'forbidden'
  | 'gated'
  | 'too_large';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** A write tool that exists so clients can discover the v1.x surface, and refuses. */
export class GatedError extends ToolError {
  constructor(tool: string) {
    super(
      'gated',
      `${tool} is gated until v1.x. wizard-ads v1 is read-only by design: it proposes, ` +
        'the operator applies, and the write path unlocks only after the crosscheck exit ' +
        'criterion is met on real profiles. Use get_recommendations and export from the web app.',
    );
    this.name = 'GatedError';
  }
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    /** Safe to send over the wire: it never distinguishes "no such key" from "revoked". */
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'AuthError';
  }
}
