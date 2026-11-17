/** Error raised when the canonical authentication writer is unavailable. */
export class AuthWriteDisabledError extends Error {
  constructor() {
    super("authentication writes are disabled in this backend");
    this.name = "AuthWriteDisabledError";
  }
}

/** Error raised for invalid authentication input. */
export class AuthValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthValidationError";
  }
}

/** Error raised when an authentication operation conflicts with state. */
export class AuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConflictError";
  }
}
