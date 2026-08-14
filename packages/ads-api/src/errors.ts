/**
 * Every failure this client can produce, as a type the caller can branch on.
 *
 * The worker's pacing policy needs to tell four situations apart and an
 * `Error` with a message cannot do it: a throttle (back off, retry the whole
 * job later), an auth failure (the connection is dead, stop the profile), a
 * report that Amazon itself declared FAILURE (never retry the same request),
 * and everything else. Message parsing at the call site is how retry storms
 * start, so the distinction is in the type.
 */

/** Base class. Everything thrown by this package is an instance of it. */
export class AdsApiError extends Error {
  override readonly name: string = 'AdsApiError';

  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** Configuration or programmer error: a region we do not know, a missing credential. */
export class AdsApiConfigError extends AdsApiError {
  override readonly name = 'AdsApiConfigError';
}

/** A non-2xx HTTP response that is not one of the specialised cases below. */
export class AdsApiHttpError extends AdsApiError {
  override readonly name: string = 'AdsApiHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** How many attempts the client had already spent when it gave up. */
    readonly attempts: number,
    detail?: unknown,
  ) {
    super(message, detail);
  }
}

/** LWA refused the grant. The refresh token is dead or the app lost its scope. */
export class AdsAuthError extends AdsApiHttpError {
  override readonly name = 'AdsAuthError';
}

/**
 * HTTP 429 after the client exhausted its own retries.
 *
 * Amazon signals throttling with the status code alone: there are no quota
 * headers, and `Retry-After` is present only sometimes. `retryAfterMs` is
 * whatever the response actually carried, not a guess.
 */
export class AdsThrottleError extends AdsApiHttpError {
  override readonly name = 'AdsThrottleError';

  constructor(
    message: string,
    status: number,
    body: string,
    attempts: number,
    readonly retryAfterMs: number | null,
    detail?: unknown,
  ) {
    super(message, status, body, attempts, detail);
  }
}

/**
 * HTTP 425: Amazon already has an identical report request in flight.
 *
 * This is a success in disguise — the right move is to adopt the existing
 * report id rather than mint a second one — so it carries the id when Amazon
 * bothers to include one in the response.
 */
export class DuplicateReportError extends AdsApiHttpError {
  override readonly name = 'DuplicateReportError';

  constructor(
    message: string,
    status: number,
    body: string,
    attempts: number,
    readonly existingReportId: string | null,
    detail?: unknown,
  ) {
    super(message, status, body, attempts, detail);
  }
}

/** HTTP 425 for a write request Amazon identifies as a duplicate. */
export class DuplicateWriteError extends AdsApiHttpError {
  override readonly name = 'DuplicateWriteError';

  constructor(
    message: string,
    status: number,
    body: string,
    attempts: number,
    readonly operation: string,
    readonly path: string,
    detail?: unknown,
  ) {
    super(message, status, body, attempts, detail);
  }
}

/** A deliberately unavailable interface seam, distinct from a remote failure. */
export class AdsApiNotImplementedError extends AdsApiError {
  override readonly name = 'AdsApiNotImplementedError';
}

/** Amazon generated the report and declared it FAILURE or CANCELLED. */
export class ReportFailedError extends AdsApiError {
  override readonly name = 'ReportFailedError';

  constructor(
    message: string,
    readonly reportId: string,
    readonly status: string,
    readonly failureReason: string | null,
  ) {
    super(message);
  }
}

/** An export finished in a terminal non-success state. */
export class ExportFailedError extends AdsApiError {
  override readonly name = 'ExportFailedError';

  constructor(
    message: string,
    readonly exportId: string,
    readonly status: string,
    readonly failureReason: string | null,
  ) {
    super(message);
  }
}

/** A bounded wait ran out. Only the smoke script waits; the worker never blocks. */
export class AdsApiTimeoutError extends AdsApiError {
  override readonly name = 'AdsApiTimeoutError';
}

/**
 * A downloaded payload did not parse, or a row did not carry the columns the
 * report was asked for. Never swallowed: a silently dropped row is the exact
 * failure Rule 4 exists to catch.
 */
export class AdsApiParseError extends AdsApiError {
  override readonly name = 'AdsApiParseError';
}
