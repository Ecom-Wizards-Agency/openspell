export class DataDiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveError';
  }
}

export class DataDiveConfigError extends DataDiveError {
  constructor(message: string) {
    super(message);
    this.name = 'DataDiveConfigError';
  }
}

export class DataDiveParseError extends DataDiveError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveParseError';
  }
}

export class DataDiveHttpError extends DataDiveError {
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'DataDiveHttpError';
  }
}

export class DataDiveThrottleError extends DataDiveHttpError {
  constructor(attempts: number, readonly retryAfterMs: number | null, responseBody: string) {
    super(`DataDive rate limit persisted after ${attempts} attempts`, 429, attempts, responseBody);
    this.name = 'DataDiveThrottleError';
  }
}

export class DataDiveTransportError extends DataDiveError {
  constructor(message: string, readonly attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveTransportError';
  }
}
