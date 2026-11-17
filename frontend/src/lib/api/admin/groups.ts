import { adminRequest, adminQuery, jsonMutation, mutationHeaders } from "./transport";
import type {
  AdminGroupListResponse,
  AdminGroupResponse,
  AdminResponse,
  AdminRoleListResponse,
} from "./types";

/** Lists groups visible to the administrator. */
export function listAdminGroups(limit = 100): Promise<AdminGroupListResponse> {
  return adminRequest(`/api/admin/groups${adminQuery({ limit })}`);
}
/** Creates a group. */
export function createAdminGroup(name: string): Promise<AdminGroupResponse> {
  return jsonMutation().then((headers) =>
    adminRequest("/api/admin/groups", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    }),
  );
}

/** Renames a group. */
export function renameAdminGroup(
  id: number,
  name: string,
): Promise<AdminGroupResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(`/api/admin/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name }),
    }),
  );
}

/** Deletes a group. */
export function deleteAdminGroup(
  id: number,
): Promise<AdminResponse<{ group_id: number }>> {
  return mutationHeaders().then((headers) =>
    adminRequest(`/api/admin/groups/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    }),
  );
}

/** Lists the roles and their authorization levels. */
export function getAdminRoles(): Promise<AdminRoleListResponse> {
  return adminRequest("/api/admin/roles");
}
