export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: ExitCode = 1) {
    super(message);
    this.name = "CliError";
  }
}

export function mapHttpStatus(status: number): ExitCode {
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status === 409 || status === 412) return 5;
  if (status === 413 || status === 422) return 2;
  return status >= 500 ? 1 : 1;
}

export function safeError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError("cli_failed", "operation failed");
}
