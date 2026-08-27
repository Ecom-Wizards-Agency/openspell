export class KeepaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeepaError';
  }
}

export class KeepaConfigError extends KeepaError {
  constructor(message: string) {
    super(message);
    this.name = 'KeepaConfigError';
  }
}

export class KeepaParseError extends KeepaError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeepaParseError';
  }
}

export class KeepaHttpError extends KeepaError {
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KeepaHttpError';
  }
}

/** Token exhaustion is healthy provider pacing, not an integration failure. */
export class KeepaRetryableError extends KeepaError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly tokensLeft: number | null,
    readonly requiredTokens: number | null,
  ) {
    super(message);
    this.name = 'KeepaRetryableError';
  }
}
