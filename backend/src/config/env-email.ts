import {
  nonEmpty,
  optionalNonEmpty,
  optionalSecret,
  positiveInteger,
} from "./env-values.js";

/** Resolved outbound email transport configuration. */
export interface EmailEnvironmentConfig {
  readonly emailTransport: "disabled" | "memory" | "smtp";
  readonly emailFrom: string;
  readonly emailPublicOrigin: string | undefined;
  readonly emailSmtpHost: string | undefined;
  readonly emailSmtpPort: number;
  readonly emailSmtpUser: string | undefined;
  readonly emailSmtpPassword: string | undefined;
}

/** Resolves email transport values and validates SMTP prerequisites. */
export function resolveEmailConfig(
  environment: NodeJS.ProcessEnv,
  authWriteMode: string | undefined,
  frontendPublicOrigin: string | undefined,
): EmailEnvironmentConfig {
  const emailTransport = (
    environment.PRG32_BACKEND_EMAIL_TRANSPORT ??
    (authWriteMode === "test" ? "memory" : "disabled")
  )
    .trim()
    .toLowerCase();
  if (
    emailTransport !== "disabled" &&
    emailTransport !== "memory" &&
    emailTransport !== "smtp"
  ) {
    throw new Error(
      "PRG32_BACKEND_EMAIL_TRANSPORT must be disabled, memory, or smtp",
    );
  }
  const emailFrom = nonEmpty(
    "PRG32_BACKEND_EMAIL_FROM",
    environment.PRG32_BACKEND_EMAIL_FROM,
    "no-reply@prg32.local",
  );
  const emailPublicOrigin = optionalNonEmpty(
    environment.PRG32_BACKEND_EMAIL_PUBLIC_ORIGIN ??
      frontendPublicOrigin ??
      (authWriteMode === "test" ? "http://store.prg32.local" : undefined),
  );
  const emailSmtpHost = optionalNonEmpty(
    environment.PRG32_BACKEND_EMAIL_SMTP_HOST,
  );
  const emailSmtpPort = positiveInteger(
    "PRG32_BACKEND_EMAIL_SMTP_PORT",
    environment.PRG32_BACKEND_EMAIL_SMTP_PORT,
    587,
  );
  const emailSmtpUser = optionalNonEmpty(
    environment.PRG32_BACKEND_EMAIL_SMTP_USER,
  );
  const emailSmtpPassword = optionalSecret(
    environment,
    "PRG32_BACKEND_EMAIL_SMTP_PASSWORD",
  );
  if (emailTransport === "smtp" && (!emailSmtpHost || !emailPublicOrigin)) {
    throw new Error(
      "SMTP email transport requires an SMTP host and public origin",
    );
  }
  return {
    emailTransport,
    emailFrom,
    emailPublicOrigin,
    emailSmtpHost,
    emailSmtpPort,
    emailSmtpUser,
    emailSmtpPassword,
  };
}
