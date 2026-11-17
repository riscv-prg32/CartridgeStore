import { AuthValidationError } from "./errors.js";

/** Maximum username length accepted by the authentication workflow. */
export const AUTH_USERNAME_MAX_LENGTH = 80;
export const AUTH_DISPLAY_NAME_MAX_LENGTH = 160;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Converts a scalar request value to its compatibility string form. */
export function authScalar(value: unknown, fallback = ""): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : fallback;
}

/** Checks the email syntax accepted by the authentication workflow. */
export function isValidAuthEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** Validates the optional human-readable name shown in the account UI. */
export function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length > AUTH_DISPLAY_NAME_MAX_LENGTH) {
    throw new AuthValidationError(
      "display name must be at most 160 characters",
    );
  }
  if ([...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new AuthValidationError("display name contains invalid characters");
  }
  return normalized;
}

/** Validates password length and confirmation equality. */
export function validatePassword(password: string, confirmation: string): void {
  if (password.length < 10) {
    throw new AuthValidationError("password must be at least 10 characters");
  }
  if (password !== confirmation) {
    throw new AuthValidationError("password confirmation does not match");
  }
}

/** Validates the complete local account bootstrap payload. */
export function validateAccountInput(
  username: string,
  email: string,
  password: string,
  confirmation: string
): void {
  if (!username || username.length > AUTH_USERNAME_MAX_LENGTH) {
    throw new AuthValidationError(
      "username is required and must be at most 80 characters"
    );
  }
  if (!isValidAuthEmail(email)) {
    throw new AuthValidationError("email must be valid");
  }
  validatePassword(password, confirmation);
}
