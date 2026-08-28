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
