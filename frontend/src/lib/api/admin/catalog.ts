import { adminRequest, adminQuery, jsonMutation, mutationHeaders } from "./transport";
import type {
  AdminCatalogListResponse,
  AdminCatalogResponse,
  AdminCartridgeDeleteResponse,
  AdminModerationResponse,
} from "./types";

export type AdminCatalogListParams = {
  page?: number;
  limit?: number;
  q?: string;
  version?: string;
  architecture?: string;
  status?: "published" | "withdrawn" | "hidden";
};

/** Lists published catalog entries for administration. */
export function listAdminCartridges(
  params: AdminCatalogListParams = {},
): Promise<AdminCatalogListResponse> {
  return adminRequest(`/api/admin/cartridges${adminQuery(params)}`);
}
/** Lists the moderation inventory, including unpublished entries. */
export function listAdminModerationInventory(
  params: AdminCatalogListParams = {},
): Promise<AdminCatalogListResponse> {
  return adminRequest(`/api/admin/catalog/moderation${adminQuery(params)}`);
}

/** Reads a cartridge from the moderation inventory. */
export function getAdminModerationCartridge(
  id: string,
  version?: string,
): Promise<AdminCatalogResponse> {
  return adminRequest(
    `/api/admin/catalog/moderation/${encodeURIComponent(id)}${adminQuery({ version })}`,
  );
}

/** Reads a published cartridge through the administrative API. */
export function getAdminCartridge(
  id: string,
  version?: string,
): Promise<AdminCatalogResponse> {
  return adminRequest(
    `/api/admin/cartridges/${encodeURIComponent(id)}${adminQuery({ version })}`,
  );
}

/** Updates cartridge metadata. */
export function updateAdminCartridge(
  id: string,
  version: string,
  metadata: Record<string, unknown>,
): Promise<AdminCatalogResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(
      `/api/admin/cartridges/${encodeURIComponent(id)}${adminQuery({ version })}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ metadata }),
      },
    ),
  );
}

/** Deletes one cartridge architecture variant. */
export function deleteAdminCartridge(
  id: string,
  version: string,
  architecture?: string,
): Promise<AdminCartridgeDeleteResponse> {
  return mutationHeaders().then((headers) =>
    adminRequest(
      `/api/admin/cartridges/${encodeURIComponent(id)}${adminQuery({
        version,
        architecture,
      })}`,
      {
        method: "DELETE",
        headers,
      },
    ),
  );
}

/** Applies a moderation action to a cartridge. */
export function moderateAdminCartridge(
  id: string,
  version: string,
  action: "hidden" | "unpublished" | "restored",
  reason = "",
): Promise<AdminModerationResponse> {
  return jsonMutation().then((headers) =>
    adminRequest(
      `/api/admin/cartridges/${encodeURIComponent(id)}/moderation${adminQuery({ version })}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ action, reason }),
      },
    ),
  );
}
