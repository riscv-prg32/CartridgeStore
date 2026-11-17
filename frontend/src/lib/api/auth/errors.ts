import { ApiRequestError } from "../client";

/** Converts authentication failures into user-facing messages. */
export function authErrorMessage(
  error: unknown,
  operation: "login" | "logout" | "session" | "providers" | "profile" = "session",
): string {
  if (error instanceof ApiRequestError) {
    if (operation === "login" && error.status === 401) {
      return "Username or password is incorrect.";
    }
    if (error.status === 403 && error.body?.code === "auth_account_disabled") {
      return "This account is disabled.";
    }
    if (error.status === 403 && error.body?.code === "csrf_failed") {
      return "Your session expired. Refresh and try again.";
    }
    if (error.status === 401 && operation === "session") {
      return "Your session has expired.";
    }
    if (error.status === 503) {
      return "The authentication service is temporarily unavailable.";
    }
    if (operation === "profile" && error.status === 400) {
      return error.body?.error ?? "The profile details are invalid.";
    }
    if (operation === "providers") {
      return "Federated login options are temporarily unavailable.";
    }
    if (operation === "logout" && error.status === 401) {
      return "Your session was already expired.";
    }
  }
  if (error instanceof TypeError) {
    return "The authentication service could not be reached.";
  }
  if (operation === "providers") {
    return "Federated login options are unavailable.";
  }
  return operation === "login"
    ? "Sign-in could not be completed. Try again."
    : "Authentication could not be completed. Try again.";
}
