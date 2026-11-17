/** Compatibility barrel for the authentication API client. */
export * from "./auth/errors";
export * from "./auth/federation";
export * from "./auth/passkeys";
export * from "./auth/password";
export * from "./auth/registration";
export * from "./auth/session";
export { getAuthCsrf } from "./auth/transport";
export * from "./auth/tokens";
