export class SpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SpApiError';
  }
}

export class SpApiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpApiParseError';
  }
}

export class SpApiAuthError extends Error {
  readonly retryable: boolean;

  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'SpApiAuthError';
    this.retryable = status === 429 || (status !== null && status >= 500);
  }
}
