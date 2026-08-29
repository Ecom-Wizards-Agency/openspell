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

/** A mutation-shaped call that the analytical MCP surface must always refuse. */
export class GatedError extends ToolError {
  constructor(tool: string) {
    super(
      'gated',
      `${tool} is unavailable through OpenSpell MCP. This service exposes analytical reads only; ` +
        'Amazon changes require an exact operator approval in the web app and worker-side audit. ' +
        'Use get_recommendations here, then review the batch in OpenSpell.',
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
