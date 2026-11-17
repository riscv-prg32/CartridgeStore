import crypto from "node:crypto";

import { FederationProviderError } from "./provider-codecs.js";

const MAX_SAML_TRUSTED_CERTIFICATES = 2;

type TextValue = (
  value: unknown,
  label: string,
  max: number,
  required?: boolean,
) => string | null;

/** Validates one SAML certificate or public key value. */
export function samlCertificate(
  value: unknown,
  text: TextValue,
): string | null {
  const normalized = text(value, "saml_idp_certificate_pem", 65536);
  if (normalized === null) return null;
  if (
    !normalized.includes("BEGIN CERTIFICATE") &&
    !normalized.includes("BEGIN PUBLIC KEY")
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_idp_certificate_pem is invalid",
    );
  }
  try {
    if (normalized.includes("BEGIN CERTIFICATE")) {
      new crypto.X509Certificate(normalized);
    } else {
      crypto.createPublicKey(normalized);
    }
  } catch {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_idp_certificate_pem is invalid",
    );
  }
  return normalized;
}

function certificateFingerprint(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value.replace(/\r\n/g, "\n").trim(), "utf8")
    .digest("hex");
}

/** Validates the bounded, duplicate-free SAML trust certificate set. */
export function samlTrustedCertificates(
  value: unknown,
  legacy: string | null,
  text: TextValue,
): string[] {
  if (value === undefined || value === null) {
    return legacy === null ? [] : [legacy];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_SAML_TRUSTED_CERTIFICATES
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_trusted_certificates_pem is invalid",
    );
  }
  const result = value.map((item) => samlCertificate(item, text));
  if (result.some((item): item is null => item === null)) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_trusted_certificates_pem is invalid",
    );
  }
  const certificates = result.filter(
    (item): item is string => item !== null,
  );
  if (
    new Set(certificates.map(certificateFingerprint)).size !==
    certificates.length
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_trusted_certificates_pem contains duplicates",
    );
  }
  return certificates;
}

/** Validates the only supported SAML NameID format. */
export function samlNameIdFormat(
  value: unknown,
  text: TextValue,
): string | null {
  const normalized = text(value, "saml_name_id_format", 160);
  if (normalized === null) return null;
  if (
    normalized !==
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_name_id_format must be persistent",
    );
  }
  return normalized;
}

/** Validates the bounded SAML accepted clock skew. */
export function samlClockSkew(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 300000
  ) {
    throw new FederationProviderError(
      "federation_provider_invalid",
      400,
      "saml_accepted_clock_skew_ms is invalid",
    );
  }
  return value;
}
