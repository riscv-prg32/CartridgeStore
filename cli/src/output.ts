import { CliError, safeError } from "./errors.js";
import type { GlobalOptions } from "./config.js";

export function printResult(value: unknown, options: GlobalOptions): void {
  if (options.quiet) return;
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printError(error: unknown, options: GlobalOptions): number {
  const value = safeError(error);
  if (options.json) process.stderr.write(`${JSON.stringify({ error: { code: value.code, message: value.message } })}\n`);
  else process.stderr.write(`Error [${value.code}]: ${value.message}\n`);
  return value.exitCode;
}

export function usageError(message: string): never { throw new CliError("usage", message, 2); }
