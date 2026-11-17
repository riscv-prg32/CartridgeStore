import { optionalNonEmpty } from "./env-values.js";

const invalidFrontendOriginMessage = [
  "PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN and PRG32_BACKEND_CORS_ORIGINS",
  " must contain valid origins",
].join("");
const insecureFrontendOriginMessage = [
  "PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN and PRG32_BACKEND_CORS_ORIGINS",
  " must contain trusted HTTPS origins",
].join("");
const corsProductionMessage = [
  "PRG32_BACKEND_CORS_ORIGINS is disabled for production builds until a ",
  "deployment-specific allowlist is reviewed",
].join("");

/** Resolved public origins and the CORS allowlist. */
export interface PublicOriginConfig {
  readonly oidcPublicOrigin: string | undefined;
  readonly federationPublicOrigin: string | undefined;
  readonly frontendPublicOrigin: string | undefined;
  readonly corsAllowedOrigins: readonly string[];
}

/** Parses public origin and CORS configuration. */
export function resolvePublicOriginConfig(
  environment: NodeJS.ProcessEnv,
): PublicOriginConfig {
  const oidcPublicOrigin = optionalNonEmpty(
    environment.PRG32_BACKEND_OIDC_PUBLIC_ORIGIN,
  );
  const federationPublicOrigin = optionalNonEmpty(
    environment.PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN ?? oidcPublicOrigin,
  );
  const frontendPublicOrigin = optionalNonEmpty(
    environment.PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN,
  );
  const corsAllowedOrigins = (
    environment.PRG32_BACKEND_CORS_ORIGINS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    oidcPublicOrigin,
    federationPublicOrigin,
    frontendPublicOrigin,
    corsAllowedOrigins,
  };
}

/** Validates public origin and CORS security policy. */
export function validatePublicOriginConfig(
  environment: NodeJS.ProcessEnv,
  config: PublicOriginConfig,
  authWriteMode: string | undefined,
  operationalMode: boolean,
): void {
  validateOptionalOrigin(
    config.oidcPublicOrigin,
    "PRG32_BACKEND_OIDC_PUBLIC_ORIGIN must be a valid origin",
    "PRG32_BACKEND_OIDC_PUBLIC_ORIGIN must be a trusted HTTPS origin",
    authWriteMode,
  );
  validateOptionalOrigin(
    config.federationPublicOrigin,
    "PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN must be a valid origin",
    "PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN must be a trusted HTTPS origin",
    authWriteMode,
  );
  for (const origin of [
    config.frontendPublicOrigin,
    ...config.corsAllowedOrigins,
  ]) {
    validateOptionalOrigin(
      origin,
      invalidFrontendOriginMessage,
      insecureFrontendOriginMessage,
      authWriteMode,
    );
  }
  if (
    (environment.NODE_ENV ?? "").trim().toLowerCase() === "production" &&
    config.corsAllowedOrigins.length > 0 &&
    !operationalMode
  ) {
    throw new Error(
      corsProductionMessage,
    );
  }
}

function validateOptionalOrigin(
  origin: string | undefined,
  invalidMessage: string,
  insecureMessage: string,
  authWriteMode: string | undefined,
): void {
  if (!origin) return;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(invalidMessage);
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && authWriteMode !== "test")
  ) {
    throw new Error(insecureMessage);
  }
}
