import { adminRequest, adminQuery, mutationHeaders } from "./transport";
import type {
  AdminResponse,
  AdminTokenListResponse,
} from "./types";

export type AdminTokenListParams = {
  page?: number;
  limit?: number;
  user_id?: number;
};

/** Lists API tokens for administrative review. */
export function listAdminTokens(
  params: AdminTokenListParams = {},
): Promise<AdminTokenListResponse> {
  return adminRequest(`/api/admin/tokens${adminQuery(params)}`);
}
/** Revokes an API token by identifier. */
export function revokeAdminToken(
  id: number,
): Promise<AdminResponse<{ token_id: number }>> {
  return mutationHeaders().then((headers) =>
    adminRequest(`/api/admin/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    }),
  );
}
