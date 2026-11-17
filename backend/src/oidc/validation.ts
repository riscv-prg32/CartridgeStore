import crypto from "node:crypto";

/** Error returned by the OIDC protocol boundary. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: { readonly link_challenge?: string }
  ) {
    super(message);
    this.name = "OidcError";
  }
}

/** Creates a stable SHA-256 binding for a protocol value. */
export function oidcDigest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) <= 31 ||
      character.charCodeAt(0) === 127
  );
}

/** Accepts bounded protocol query values without control characters. */
export function safeOidcString(value: string | null, max: number): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

/** Validates the local return path used after OIDC authentication. */
export function safeOidcReturnPath(value: string | null): string {
  const candidate = value ?? "/";
  if (
    candidate.length > 512 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    hasControlCharacter(candidate)
  ) {
    throw new OidcError(
      "oidc_return_path_invalid",
      400,
      "return path is invalid"
    );
  }
  return candidate;
}

/** Parses and validates a provider origin used for OIDC network calls. */
export function oidcUrlOrigin(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OidcError(
      "oidc_provider_invalid",
      503,
      "OIDC provider configuration is invalid"
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
  ) {
    throw new OidcError(
      "oidc_provider_invalid",
      503,
      "OIDC provider configuration is invalid"
    );
  }
  return parsed;
}

/** Ensures a discovered endpoint remains bound to the configured issuer. */
export function assertOidcBoundEndpoint(
  value: unknown,
  issuer: URL,
  allowHttp: boolean
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new OidcError(
      "oidc_metadata_invalid",
      503,
      "OIDC provider metadata is invalid"
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new OidcError(
      "oidc_metadata_invalid",
      503,
      "OIDC provider metadata is invalid"
    );
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    (endpoint.protocol !== "https:" &&
      (!allowHttp || endpoint.protocol !== "http:")) ||
    endpoint.origin !== issuer.origin
  ) {
    throw new OidcError(
      "oidc_metadata_invalid",
      503,
      "OIDC provider metadata is invalid"
    );
  }
  return endpoint.toString();
}
