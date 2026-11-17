import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** Parses a required positive integer environment value. */
export function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return candidate;
}

/** Parses a required non-empty string with a fallback. */
export function nonEmpty(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const candidate = (value ?? fallback).trim();
  if (!candidate) {
    throw new Error(`${name} must not be empty`);
  }
  return candidate;
}

/** Parses the boolean spellings accepted by backend environment variables. */
export function booleanValue(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

/** Returns a trimmed optional string, treating empty values as absent. */
export function optionalNonEmpty(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

/**
 * Resolves a secret from an inline value or a Docker-compatible secret file.
 *
 * The file form is intentionally opt-in through `${name}_FILE`, preserving
 * existing environment-based deployments while keeping secret contents out of
 * Compose interpolation and process arguments.
 */
export function optionalSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const inlineValue = optionalNonEmpty(environment[name]);
  const fileValue = optionalNonEmpty(environment[`${name}_FILE`]);
  if (inlineValue && fileValue) {
    throw new Error(`${name} and ${name}_FILE cannot both be set`);
  }
  if (!fileValue) return inlineValue;
  if (!path.isAbsolute(fileValue) || fileValue.includes("\0")) {
    throw new Error(`${name}_FILE must be an absolute path`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(fileValue);
  } catch {
    throw new Error(`${name}_FILE is unavailable`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${name}_FILE must be a regular file`);
  }
  if (stats.size <= 0 || stats.size > MAX_SECRET_FILE_BYTES) {
    throw new Error(`${name}_FILE has an invalid size`);
  }

  const secret = optionalNonEmpty(fs.readFileSync(fileValue, "utf8"));
  if (!secret) throw new Error(`${name}_FILE must not be empty`);
  return secret;
}

/** Parses and validates the trusted proxy CIDR allowlist. */
export function proxyCidrs(value: string | undefined): string[] {
  const entries = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [address, prefix] = entry.split("/", 2);
    const family = net.isIP(address ?? "");
    if (family === 0) {
      throw new Error(
        "PRG32_BACKEND_TRUST_PROXY_CIDRS contains an invalid address",
      );
    }
    if (prefix !== undefined) {
      const parsed = Number(prefix);
      const maximum = family === 4 ? 32 : 128;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw new Error(
          "PRG32_BACKEND_TRUST_PROXY_CIDRS contains an invalid prefix",
        );
      }
    }
  }
  return entries;
}

/** Detects SQLite URI forms that are not valid filesystem paths. */
export function looksLikeSqliteUri(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("file:") ||
    normalized.includes("?mode=") ||
    normalized.includes("&mode=")
  );
}

/** Requires a sufficiently strong secret for an enabled writer boundary. */
export function requiredSecret(
  name: string,
  value: string | undefined,
): string {
  const candidate = optionalNonEmpty(value);
  if (!candidate) {
    throw new Error(`${name} is required when auth writes are enabled`);
  }
  if (candidate.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return candidate;
}
