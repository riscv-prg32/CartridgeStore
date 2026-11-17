import crypto from "node:crypto";

/** Stable name-id format required by the PRG32 SAML contract. */
export const SAML_PERSISTENT_NAME_ID =
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";

/** Error returned by the SAML protocol boundary. */
export class SamlError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: { readonly link_challenge?: string }
  ) {
    super(message);
    this.name = "SamlError";
  }
}

/** Creates a stable SHA-256 binding for a SAML protocol value. */
export function samlDigest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) <= 31 ||
      character.charCodeAt(0) === 127
  );
}

/** Accepts bounded SAML values without control characters. */
export function boundedSamlValue(
  value: string | null | undefined,
  max: number
): string | null {
  if (!value || value.length > max || hasControlCharacter(value)) return null;
  return value;
}

/** Validates the local return path used after SAML authentication. */
export function safeSamlReturnPath(value: string | null): string {
  const candidate = value ?? "/";
  if (
    candidate.length > 512 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    hasControlCharacter(candidate)
  ) {
    throw new SamlError(
      "saml_return_path_invalid",
      400,
      "SAML return path is invalid"
    );
  }
  return candidate;
}

/** Validates a configured SAML certificate before passing it to Node-SAML. */
export function validateSamlCertificate(
  value: string | null,
  label: string
): string {
  if (
    !value ||
    value.length > 65536 ||
    (!value.includes("BEGIN CERTIFICATE") &&
      !value.includes("BEGIN PUBLIC KEY"))
  ) {
    throw new SamlError(
      "saml_provider_incomplete",
      503,
      `${label} is unavailable`
    );
  }
  if (value.includes("BEGIN CERTIFICATE")) {
    try {
      const parsed = new crypto.X509Certificate(value);
      const now = Date.now();
      if (
        now < Date.parse(parsed.validFrom) ||
        now > Date.parse(parsed.validTo)
      ) {
        throw new SamlError(
          "saml_certificate_expired",
          401,
          "SAML signing certificate is not currently valid"
        );
      }
    } catch (error) {
      if (error instanceof SamlError) throw error;
      throw new SamlError(
        "saml_provider_invalid",
        503,
        `${label} is invalid`
      );
    }
  }
  return value;
}
