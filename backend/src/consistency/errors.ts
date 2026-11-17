export class PublicationConsistencyError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code = "publication_consistency_failed", details?: unknown) {
    super(message);
    this.name = "PublicationConsistencyError";
    this.code = code;
    this.details = details;
  }
}
