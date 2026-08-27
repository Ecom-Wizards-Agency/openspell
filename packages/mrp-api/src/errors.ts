export class MrpApiError extends Error {
  override readonly name: string = 'MrpApiError';
}

export class MrpConfigError extends MrpApiError {
  override readonly name = 'MrpConfigError';
}

export class MrpHttpError extends MrpApiError {
  override readonly name: string = 'MrpHttpError';

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class MrpTransportError extends MrpApiError {
  override readonly name = 'MrpTransportError';
}

export class MrpAuthError extends MrpHttpError {
  override readonly name = 'MrpAuthError';
}

export class MrpProtocolError extends MrpApiError {
  override readonly name = 'MrpProtocolError';
}

export class MrpToolNotFoundError extends MrpApiError {
  override readonly name = 'MrpToolNotFoundError';
}

export class MrpToolCallError extends MrpApiError {
  override readonly name = 'MrpToolCallError';
}

export class MrpParseError extends MrpApiError {
  override readonly name = 'MrpParseError';
}
