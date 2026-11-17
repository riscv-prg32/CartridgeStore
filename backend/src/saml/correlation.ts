import crypto from "node:crypto";

import type { BackendConfig } from "../config/env.js";

export const SAML_CORRELATION_COOKIE = "prg32_saml_correlation";
const PREFIX = "v1";

export interface SamlCorrelation {
  readonly transactionId: string;
  readonly binding: string;
}

function signature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function createSamlCorrelation(secret: string, transactionId: string, binding: string): string {
  const payload = PREFIX + "." + transactionId + "." + binding;
  return payload + "." + signature(secret, payload);
}

export function parseSamlCorrelation(secret: string, value: string | undefined): SamlCorrelation | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX || !parts[1] || !parts[2] || !parts[3]) return null;
  const expected = Buffer.from(signature(secret, parts.slice(0, 3).join(".")), "base64url");
  const actual = Buffer.from(parts[3], "base64url");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43,128}$/.test(parts[2])) return null;
  return { transactionId: parts[1], binding: parts[2] };
}

function cookieAttributes(config: BackendConfig, maxAge: number): string[] {
  // SameSite=None is required because an IdP POST is cross-site. Secure is
  // deliberately unconditional: a browser must not accept a None cookie over
  // HTTP. Fastify inject tests can still carry this header in test mode.
  const attributes = ["Path=/", "HttpOnly", "SameSite=None", "Secure", "Max-Age=" + maxAge];
  if (config.authCookieDomain) attributes.push("Domain=" + config.authCookieDomain);
  return attributes;
}

export function serializeSamlCorrelationCookie(config: BackendConfig, value: string, maxAge = 300): string {
  return SAML_CORRELATION_COOKIE + "=" + encodeURIComponent(value) + "; " + cookieAttributes(config, maxAge).join("; ");
}

export function clearSamlCorrelationCookie(config: BackendConfig): string {
  return serializeSamlCorrelationCookie(config, "", 0).replace("=;", "=;");
}
