import { ApiRequestError } from "../../lib/api/client";
import type { SetupStep } from "../../lib/api/setup";

/** Values collected by the setup wizard form. */
export type SetupFormState = Record<string, string | boolean>;

/** Convert an unknown setup failure into the user-facing message. */
export function setupErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.body?.error ?? error.message;
  }
  return error instanceof Error
    ? error.message
    : "The installation request failed.";
}

/** Map one setup step's form values to its backend payload. */
export function payloadFor(
  step: SetupStep,
  form: SetupFormState,
): Record<string, unknown> {
  const value = (name: string, fallback: string | boolean = "") =>
    form[name] ?? fallback;
  if (step === "admin") {
    return {
      username: value("username"),
      email: value("email"),
      password: value("password"),
      password_confirm: value("password_confirm"),
    };
  }
  if (step === "store") {
    return {
      "application.store_name": value(
        "store_name",
        "PRG32 Cartridge Store",
      ),
      "application.store_description": value("store_description"),
      "application.contact_email": value("contact_email"),
    };
  }
  if (step === "registration") {
    return {
      "registration.enabled": Boolean(value("registration_enabled", true)),
      "registration.require_email_verification": Boolean(
        value("email_verification", false),
      ),
    };
  }
  if (step === "security") {
    return {
      "session.lifetime_seconds": Number(
        value("session_lifetime", "86400"),
      ),
      "publishing.enabled": Boolean(value("publishing_enabled", true)),
      "review.require_note_on_rejection": Boolean(value("review_note", false)),
      "security.notify_user_on_account_change": Boolean(
        value("notify_account", true),
      ),
    };
  }
  if (step === "smtp") {
    return {
      enabled: Boolean(value("smtp_enabled", false)),
      "smtp.enabled": Boolean(value("smtp_enabled", false)),
      "smtp.host": value("smtp_host"),
      "smtp.port": Number(value("smtp_port", "1025")),
      "smtp.encryption": value("smtp_encryption", "none"),
      "smtp.secure": Boolean(value("smtp_secure", false)),
      "smtp.auth_enabled": Boolean(value("smtp_auth", false)),
      "smtp.username": value("smtp_username"),
      "smtp.password": value("smtp_password"),
      "smtp.from_name": value("smtp_from_name", "PRG32 Cartridge Store"),
      "smtp.from_email": value("smtp_from_email"),
      "smtp.reply_to": value("smtp_reply_to"),
    };
  }
  if (step === "oidc") {
    return {
      enabled: Boolean(value("oidc_enabled", false)),
      provider_id: value("oidc_provider_id"),
      display_name: value("oidc_display_name"),
      issuer: value("oidc_issuer"),
      client_id: value("oidc_client_id"),
      client_secret: value("oidc_client_secret"),
      client_auth_method: value("oidc_auth_method", "client_secret_basic"),
    };
  }
  if (step === "saml") {
    return {
      enabled: Boolean(value("saml_enabled", false)),
      provider_id: value("saml_provider_id"),
      display_name: value("saml_display_name"),
      idp_entity_id: value("saml_idp_entity_id"),
      saml_entry_point: value("saml_entry_point"),
      saml_idp_certificate_pem: value("saml_certificate"),
    };
  }
  if (step === "mdns") {
    return { enabled: Boolean(value("mdns_enabled", false)) };
  }
  return {};
}
