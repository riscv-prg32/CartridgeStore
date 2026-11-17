import { ApiRequestError } from "../client";

/** Converts federation administration failures into user-facing messages. */
export function federationErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const code = error.body?.code;
    const known: Record<string, string> = {
      auth_required: "Your session has expired. Sign in again.",
      permission_denied:
        "Your account does not have permission for this area.",
      csrf_failed:
        "The security token expired. Refresh the page and try again.",
      recent_reauthentication_required:
        "Local administrator reauthentication is required.",
      reauthentication_failed:
        "The local administrator password is incorrect.",
      rate_limited: "Too many attempts. Wait before trying again.",
      federation_provider_conflict: "That provider ID is already in use.",
      federation_identity_conflict:
        "That external identity is already linked.",
      federation_identity_retired:
        "That external identity was retired and cannot be reused.",
      federation_user_unknown: "The local user does not exist.",
      federation_account_disabled: "The selected local account is disabled.",
      federation_last_auth_method:
        "The identity cannot be retired because it is the last usable login method.",
      federation_provider_invalid:
        "The provider configuration was rejected. Check the highlighted values.",
    };
    return (
      (code && known[code]) ||
      error.body?.error ||
      "The federation administration operation was rejected."
    );
  }
  if (error instanceof TypeError) {
    return "The federation administration service could not be reached.";
  }
  if (error instanceof Error) return error.message;
  return "The federation administration operation failed.";
}
