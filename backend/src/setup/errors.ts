/** Error returned by the first-installation workflow boundary. */
export class SetupError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SetupError";
  }
}
