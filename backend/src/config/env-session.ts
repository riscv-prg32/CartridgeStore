import { booleanValue, optionalNonEmpty } from "./env-values.js";

export type AuthCookieSameSite = "lax" | "strict" | "none";

/** Resolved authentication session cookie settings. */
export interface SessionCookieConfig {
  readonly authCookieSecure: boolean;
  readonly authCookieSameSite: AuthCookieSameSite;
  readonly authCookieDomain: string | undefined;
}

/** Parses and validates authentication session cookie settings. */
export function resolveSessionCookieConfig(
  environment: NodeJS.ProcessEnv,
): SessionCookieConfig {
  const authCookieSameSite = (
    environment.PRG32_BACKEND_SESSION_SAMESITE ?? "lax"
  ).trim().toLowerCase();
  if (
    authCookieSameSite !== "lax" &&
    authCookieSameSite !== "strict" &&
    authCookieSameSite !== "none"
  ) {
    throw new Error(
      "PRG32_BACKEND_SESSION_SAMESITE must be lax, strict, or none",
    );
  }
  const authCookieSecure = booleanValue(
    "PRG32_BACKEND_SESSION_SECURE",
    environment.PRG32_BACKEND_SESSION_SECURE,
    (environment.NODE_ENV ?? "").trim().toLowerCase() === "production",
  );
  if (
    (environment.NODE_ENV ?? "").trim().toLowerCase() === "production" &&
    !authCookieSecure
  ) {
    throw new Error(
      "PRG32_BACKEND_SESSION_SECURE must remain enabled in production",
    );
  }
  if (authCookieSameSite === "none" && !authCookieSecure) {
    throw new Error("SameSite=None requires a Secure authentication cookie");
  }
  const authCookieDomain = optionalNonEmpty(
    environment.PRG32_BACKEND_SESSION_COOKIE_DOMAIN,
  );
  if (
    authCookieDomain &&
    !/^\.?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(authCookieDomain)
  ) {
    throw new Error(
      "PRG32_BACKEND_SESSION_COOKIE_DOMAIN must be a valid cookie domain",
    );
  }
  if (authCookieDomain?.includes("..")) {
    throw new Error(
      "PRG32_BACKEND_SESSION_COOKIE_DOMAIN must not contain empty labels",
    );
  }

  return {
    authCookieSecure,
    authCookieSameSite,
    authCookieDomain,
  };
}
