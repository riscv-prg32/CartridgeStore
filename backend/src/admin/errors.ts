/** Error returned by the administrative identity boundary. */
export class AdminError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "AdminError";
  }
}
