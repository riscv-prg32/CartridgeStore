import {
  csrfResponseSchema,
} from "../schemas";
import {
  adminRequest,
  jsonMutation,
  mutationHeaders,
} from "./transport";
import type {
  AdminAssetResponse,
  AdminResponse,
  AdminSettingsResponse,
} from "./types";

/** Reads the runtime settings visible to an administrator. */
export function getAdminSettings(): Promise<AdminSettingsResponse> {
  return adminRequest("/api/admin/settings");
}

/** Applies a partial settings update using the backend's existing contract. */
export function updateAdminSettings(
  patch: Record<string, unknown>,
): Promise<AdminSettingsResponse> {
  return jsonMutation().then((headers) =>
    adminRequest("/api/admin/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    }),
  );
}

/** Verifies the configured SMTP connection. */
export function testAdminSmtpConnection(): Promise<
  AdminResponse<{ result: string }>
> {
  return jsonMutation().then((headers) =>
    adminRequest("/api/admin/settings/smtp/test-connection", {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
}

/** Sends the backend's configured SMTP test message. */
export function sendAdminSmtpTestMessage(
  to: string,
): Promise<AdminResponse<{ result: string }>> {
  return jsonMutation().then((headers) =>
    adminRequest("/api/admin/settings/smtp/test-message", {
      method: "POST",
      headers,
      body: JSON.stringify({ to }),
    }),
  );
}

/** Uploads a supported application asset. */
export function uploadAdminAsset(
  kind: "logo" | "favicon",
  file: File,
): Promise<AdminAssetResponse> {
  return mutationHeaders().then((headers) => {
    const body = new FormData();
    body.append("asset", file);
    return adminRequest(`/api/admin/settings/assets/${kind}`, {
      method: "POST",
      headers,
      body,
    });
  });
}

/** Removes a managed application asset and restores the bundled fallback. */
export function deleteAdminAsset(
  kind: "logo" | "favicon",
): Promise<AdminResponse<{ asset: { kind: string; deleted: boolean } }>> {
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/settings/assets/${kind}`, {
      method: "DELETE",
      headers,
    }),
  );
}

export { csrfResponseSchema };
