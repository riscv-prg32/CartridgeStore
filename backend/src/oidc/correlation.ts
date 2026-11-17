import crypto from "node:crypto";

import type { BackendConfig } from "../config/env.js";

export const OIDC_CORRELATION_COOKIE = "prg32_oidc_correlation";
const PREFIX = "v1";

export interface OidcCorrelation {
  readonly transactionId: string;
  readonly binding: string;
}

function signature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function createCorrelation(secret: string, transactionId: string, binding: string): string {
  const payload = PREFIX + "." + transactionId + "." + binding;
  return payload + "." + signature(secret, payload);
}

export function parseCorrelation(secret: string, value: string | undefined): OidcCorrelation | null {
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
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=" + maxAge];
  if (config.authCookieDomain) attributes.push("Domain=" + config.authCookieDomain);
  if (config.authCookieSecure) attributes.push("Secure");
  return attributes;
}

export function serializeCorrelationCookie(config: BackendConfig, value: string, maxAge = 300): string {
  return OIDC_CORRELATION_COOKIE + "=" + encodeURIComponent(value) + "; " + cookieAttributes(config, maxAge).join("; ");
}

export function clearCorrelationCookie(config: BackendConfig): string {
  return OIDC_CORRELATION_COOKIE + "=; " + cookieAttributes(config, 0).join("; ");
}
