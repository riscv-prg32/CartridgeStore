import { ApiRequestError } from "../../lib/api/client";
import { authErrorMessage } from "../../lib/api/auth";
import { StatusMessage } from "../ui/status";

export function accountOperationError(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 403) return "This account is not allowed to manage API tokens.";
  return authErrorMessage(error, "session");
}

export function AccountError({ error }: { error: unknown }) {
  return <StatusMessage tone="danger" className="mt-4 border-0 bg-transparent px-0 py-0">{accountOperationError(error)}</StatusMessage>;
}
