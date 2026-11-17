import type { Principal } from "../contracts";

/** Shared success envelope returned by the administrative API. */
export type AdminResponse<T> = { ok: true } & T;

/** Describes one runtime or application setting exposed to administrators. */
export type AdminSetting = {
  value: unknown;
  type: string;
  writable: boolean;
  restart_required: boolean;
  runtime: string;
};

export type AdminSettings = Record<string, AdminSetting>;

/** Response returned by the administrative settings endpoint. */
export type AdminSettingsResponse = AdminResponse<{
  settings: AdminSettings;
  application_settings: Record<
    string,
    {
      value: unknown;
      type: string;
      category: string;
      sensitivity: string;
      writable: boolean;
      version: number;
    }
  >;
  read_only: Record<string, unknown>;
}>;

/** Administrative representation of a user account. */
export type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: string;
  external_provider: string | null;
  created_at: string;
  last_login: string | null;
  groups: Array<{ id: number; name: string; created_at: string }>;
  account_status: "active" | "suspended" | "banned" | "disabled";
  status_reason: string | null;
  status_changed_at: string | null;
  status_expires_at: string | null;
};

export type AdminGroup = {
  id: number;
  name: string;
  created_at: string;
  user_count: number;
};

export type AdminRole = {
  name: string;
  level: number;
  user_count: number;
};

export type AdminToken = {
  id: number;
  user_id: number;
  username: string;
  label: string;
  created_at: string;
  last_used: string;
};

export type AdminAuditEvent = {
  event_id: string;
  timestamp: string;
  actor_user_id: number | null;
  target_type: string;
  target_id: string;
  action: string;
  outcome: string;
  summary?: Record<string, unknown>;
  request_id: string;
};

export type AdminAuditChange = {
  key: string;
  before: unknown;
  after: unknown;
};

export type AdminCartridgeVariant = {
  architecture: string;
  size: number;
  sha256: string;
  icon_mime: string | null;
  screenshot_mime: string | null;
  has_screenshot: boolean;
  has_signature: boolean;
  updated_at: unknown;
};

export type AdminCartridge = {
  id: string;
  title: string;
  summary: string;
  authors: unknown[];
  tags: unknown[];
  latest_version: unknown;
  selected_version: string;
  versions: string[];
  architectures: string[];
  metadata: Record<string, unknown> | null;
  colophon: Record<string, unknown> | null;
  variants: Record<string, AdminCartridgeVariant>;
  publisher: string;
  updated_at: unknown;
  publication_state: "published";
  artifact_state: "available" | "inconsistent" | "unavailable";
  moderation_action?: "visible" | "hidden" | "unpublished";
  moderation_reason?: string;
  moderation_updated_at?: unknown;
};

/** Generic paginated administrative response shape kept for compatibility. */
export type AdminPage<T> = {
  ok: true;
  [key: string]: unknown;
  page: number;
  limit: number;
  total: number;
} & Record<string, T[] | number | boolean>;

export type AdminUserListResponse = AdminResponse<{
  users: AdminUser[];
  page: number;
  limit: number;
  total: number;
}>;

export type AdminGroupListResponse = AdminResponse<{
  groups: AdminGroup[];
  limit: number;
}>;

export type AdminRoleListResponse = AdminResponse<{
  roles: AdminRole[];
}>;

export type AdminTokenListResponse = AdminResponse<{
  tokens: AdminToken[];
  page: number;
  limit: number;
  total: number;
}>;

export type AdminCatalogListResponse = AdminResponse<{
  cartridges: AdminCartridge[];
  page: number;
  limit: number;
  total: number;
}>;

export type AdminUserResponse = AdminResponse<{ user: AdminUser }>;
export type AdminGroupResponse = AdminResponse<{ group: AdminGroup }>;
export type AdminCatalogResponse = AdminResponse<{ cartridge: AdminCartridge }>;

export type AdminAuditResponse = AdminResponse<{
  events: AdminAuditEvent[];
  limit: number;
}>;

export type AdminAuditEventResponse = AdminResponse<{
  event: AdminAuditEvent;
}>;

export type AdminPrincipalResponse = AdminResponse<{ user: Principal }>;

export type AdminAssetResponse = AdminResponse<{
  asset: {
    kind: string;
    url: string;
    mime_type: string;
    size: number;
  };
}>;

export type AdminCartridgeDeleteResponse = AdminResponse<{
  id: string;
  version: string;
  architecture: string | null;
  deleted: true;
}>;

export type AdminModerationResponse = AdminResponse<{
  moderation: {
    id: string;
    version: string;
    action: string;
    reason: string;
  };
}>;
