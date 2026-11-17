import { requestApiJson, withCsrfToken } from "../client";
import { setupResultResponseSchema } from "../schemas";

/** Tests the configured SMTP connection. */
export function testSetupSmtpConnection(csrfToken: string) {
  return requestApiJson(
    "/api/setup/smtp/test-connection",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken, {
        "content-type": "application/json",
      }),
      body: "{}",
    },
    setupResultResponseSchema,
  );
}

/** Sends a setup SMTP test message. */
export function testSetupSmtpMessage(csrfToken: string, to: string) {
  return requestApiJson(
    "/api/setup/smtp/test-message",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ to }),
    },
    setupResultResponseSchema,
  );
}

/** Validates the configured OIDC issuer. */
export function validateSetupOidc(csrfToken: string, issuer: string) {
  return requestApiJson(
    "/api/setup/federation/oidc/validate",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ issuer }),
    },
    setupResultResponseSchema,
  );
}

/** Imports SAML metadata from a URL or XML document. */
export function importSetupSamlMetadata(
  csrfToken: string,
  input: { url?: string; xml?: string },
) {
  return requestApiJson(
    "/api/setup/federation/saml/metadata",
    {
      method: "POST",
      headers: withCsrfToken(csrfToken, {
        "content-type": "application/json",
      }),
      body: JSON.stringify(input),
    },
    setupResultResponseSchema,
  );
}
