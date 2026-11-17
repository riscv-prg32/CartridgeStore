/** Error raised by settings and managed-asset operations. */
export class SettingsError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SettingsError";
  }
}
