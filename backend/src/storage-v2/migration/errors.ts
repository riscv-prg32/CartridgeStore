/** Error raised while validating or executing a storage migration. */
export class MigrationError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code = "migration_failed",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
    this.code = code;
  }
}
