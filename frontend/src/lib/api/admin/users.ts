import { adminRequest, adminQuery, jsonMutation, mutationHeaders } from "./transport";
import type {
  AdminResponse,
  AdminUserListResponse,
  AdminUserResponse,
} from "./types";

export type AdminUserListParams = {
  page?: number;
  limit?: number;
  q?: string;
  role?: string;
  group_id?: number;
};

/** Lists users with the administrative filters supported by Fastify. */
export function listAdminUsers(
  params: AdminUserListParams = {},
): Promise<AdminUserListResponse> {
  return adminRequest(`/api/admin/users${adminQuery(params)}`);
}
/** Reads one administrative user by numeric identifier. */
export function getAdminUser(id: number): Promise<AdminUserResponse> {
  return adminRequest(`/api/admin/users/${encodeURIComponent(id)}`);
}

/** Creates an administrative user using the existing request payload. */
export function createAdminUser(
  input: Record<string, unknown>,
): Promise<AdminUserResponse> {
  return jsonMutation().then((headers) =>
    adminRequest("/api/admin/users", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }),
  );
}

/** Applies a partial update to an administrative user. */
export function updateAdminUser(
  id: number,
  input: Record<string, unknown>,
): Promise<AdminUserResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(input),
    }),
  );
}

/** Changes a user's account status. */
export function setAdminUserStatus(
  id: number,
  status: "active" | "suspended" | "banned",
  reason = "",
  expiresAt?: string,
): Promise<AdminUserResponse> {
  const body = {
    status,
    reason,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** Changes a user's role. */
export function setAdminUserRole(
  id: number,
  role: string,
): Promise<AdminUserResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(id)}/role`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role }),
    }),
  );
}

/** Replaces a user's group membership. */
export function replaceAdminUserGroups(
  id: number,
  groupIds: number[],
): Promise<AdminUserResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(id)}/groups`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ group_ids: groupIds }),
    }),
  );
}

/** Deletes a user through the administrative API. */
export function deleteAdminUser(
  id: number,
): Promise<AdminResponse<{ user_id: number }>> {
  return mutationHeaders().then((headers) =>
    adminRequest(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    }),
  );
}
