export type SettingValue = string | boolean | number | readonly string[];
export type SettingType = "string" | "boolean" | "number" | "string[]";
export type SettingVisibility = "writable" | "read_only" | "asset" | "deferred" | "excluded";

export interface SettingDefinition {
  readonly key: string;
  readonly type: SettingType;
  readonly defaultValue?: SettingValue;
  readonly visibility: SettingVisibility;
  readonly maxLength?: number;
  readonly runtime: "immediate" | "next_request" | "fixed" | "future_frontend" | "legacy_only" | "deployment" | "excluded";
  readonly restartRequired: boolean;
  readonly sensitivity: "public" | "internal" | "secret";
}

/** The exact legacy store_settings inventory, classified once in code. */
export const LEGACY_SETTING_KEYS = [
  "store_name", "store_tagline", "store_contact_email", "store_institution",
  "theme_primary_color", "theme_secondary_color", "theme_font_family",
  "theme_logo_url", "theme_favicon_url", "theme_custom_css",
  "auth_allow_registration", "auth_require_email_domain", "auth_default_role",
  "publish_require_auth", "publish_max_bundle_mb", "publish_allowed_architectures",
  "mdns_enabled", "mdns_name", "mdns_type", "mdns_port",
  "smtp_host", "smtp_port", "smtp_from", "smtp_user", "smtp_password", "smtp_tls",
  "oidc_enabled", "oidc_issuer", "oidc_client_id", "oidc_client_secret", "oidc_scope",
  "saml_enabled", "saml_entity_id", "saml_acs_url", "saml_sls_url",
  "saml_idp_entity_id", "saml_idp_sso_url", "saml_idp_slo_url", "saml_idp_x509cert"
] as const;

export type LegacySettingKey = typeof LEGACY_SETTING_KEYS[number];
export type WritableSettingKey =
  | "store_name"
  | "store_tagline"
  | "store_contact_email"
  | "store_institution"
  | "theme_primary_color"
  | "theme_secondary_color"
  | "theme_font_family"
  | "auth_allow_registration";

export const DEFAULT_SETTING_VALUES: Readonly<Record<LegacySettingKey, SettingValue>> = {
  store_name: "PRG32 Cartridge Store",
  store_tagline: "",
  store_contact_email: "",
  store_institution: "",
  theme_primary_color: "#1a73e8",
  theme_secondary_color: "#174ea6",
  theme_font_family: "system-ui, sans-serif",
  theme_logo_url: "",
  theme_favicon_url: "",
  theme_custom_css: "",
  auth_allow_registration: true,
  auth_require_email_domain: "",
  auth_default_role: "user",
  publish_require_auth: true,
  publish_max_bundle_mb: 64,
  publish_allowed_architectures: ["qemu", "esp32c6"],
  mdns_enabled: true,
  mdns_name: "",
  mdns_type: "_prg32store._tcp.local.",
  mdns_port: 5080,
  smtp_host: "",
  smtp_port: 587,
  smtp_from: "noreply@localhost",
  smtp_user: "",
  smtp_password: "",
  smtp_tls: true,
  oidc_enabled: false,
  oidc_issuer: "",
  oidc_client_id: "",
  oidc_client_secret: "",
  oidc_scope: "openid email profile",
  saml_enabled: false,
  saml_entity_id: "",
  saml_acs_url: "",
  saml_sls_url: "",
  saml_idp_entity_id: "",
  saml_idp_sso_url: "",
  saml_idp_slo_url: "",
  saml_idp_x509cert: ""
};

export const SETTINGS: Readonly<Record<LegacySettingKey, SettingDefinition>> = {
  store_name: { key: "store_name", type: "string", defaultValue: DEFAULT_SETTING_VALUES.store_name, visibility: "writable", maxLength: 120, runtime: "next_request", restartRequired: false, sensitivity: "public" },
  store_tagline: { key: "store_tagline", type: "string", defaultValue: DEFAULT_SETTING_VALUES.store_tagline, visibility: "writable", maxLength: 240, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  store_contact_email: { key: "store_contact_email", type: "string", defaultValue: DEFAULT_SETTING_VALUES.store_contact_email, visibility: "writable", maxLength: 254, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  store_institution: { key: "store_institution", type: "string", defaultValue: DEFAULT_SETTING_VALUES.store_institution, visibility: "writable", maxLength: 160, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  theme_primary_color: { key: "theme_primary_color", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_primary_color, visibility: "writable", maxLength: 7, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  theme_secondary_color: { key: "theme_secondary_color", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_secondary_color, visibility: "writable", maxLength: 7, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  theme_font_family: { key: "theme_font_family", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_font_family, visibility: "writable", maxLength: 80, runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  theme_logo_url: { key: "theme_logo_url", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_logo_url, visibility: "asset", runtime: "next_request", restartRequired: false, sensitivity: "public" },
  theme_favicon_url: { key: "theme_favicon_url", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_favicon_url, visibility: "asset", runtime: "next_request", restartRequired: false, sensitivity: "public" },
  theme_custom_css: { key: "theme_custom_css", type: "string", defaultValue: DEFAULT_SETTING_VALUES.theme_custom_css, visibility: "deferred", runtime: "future_frontend", restartRequired: false, sensitivity: "public" },
  auth_allow_registration: { key: "auth_allow_registration", type: "boolean", defaultValue: DEFAULT_SETTING_VALUES.auth_allow_registration, visibility: "writable", runtime: "next_request", restartRequired: false, sensitivity: "internal" },
  auth_require_email_domain: { key: "auth_require_email_domain", type: "string", defaultValue: DEFAULT_SETTING_VALUES.auth_require_email_domain, visibility: "read_only", maxLength: 253, runtime: "legacy_only", restartRequired: false, sensitivity: "internal" },
  auth_default_role: { key: "auth_default_role", type: "string", defaultValue: "user", visibility: "read_only", runtime: "fixed", restartRequired: false, sensitivity: "internal" },
  publish_require_auth: { key: "publish_require_auth", type: "boolean", defaultValue: true, visibility: "read_only", runtime: "fixed", restartRequired: false, sensitivity: "internal" },
  publish_max_bundle_mb: { key: "publish_max_bundle_mb", type: "number", defaultValue: 64, visibility: "read_only", runtime: "deployment", restartRequired: true, sensitivity: "internal" },
  publish_allowed_architectures: { key: "publish_allowed_architectures", type: "string[]", defaultValue: ["qemu", "esp32c6"], visibility: "read_only", runtime: "fixed", restartRequired: false, sensitivity: "internal" },
  mdns_enabled: { key: "mdns_enabled", type: "boolean", defaultValue: true, visibility: "read_only", runtime: "legacy_only", restartRequired: true, sensitivity: "internal" },
  mdns_name: { key: "mdns_name", type: "string", defaultValue: "", visibility: "read_only", maxLength: 253, runtime: "legacy_only", restartRequired: true, sensitivity: "internal" },
  mdns_type: { key: "mdns_type", type: "string", defaultValue: "_prg32store._tcp.local.", visibility: "read_only", maxLength: 253, runtime: "fixed", restartRequired: true, sensitivity: "internal" },
  mdns_port: { key: "mdns_port", type: "number", defaultValue: 5080, visibility: "read_only", runtime: "fixed", restartRequired: true, sensitivity: "internal" },
  smtp_host: { key: "smtp_host", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "secret" },
  smtp_port: { key: "smtp_port", type: "number", defaultValue: 587, visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  smtp_from: { key: "smtp_from", type: "string", defaultValue: "noreply@localhost", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  smtp_user: { key: "smtp_user", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "secret" },
  smtp_password: { key: "smtp_password", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "secret" },
  smtp_tls: { key: "smtp_tls", type: "boolean", defaultValue: true, visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  oidc_enabled: { key: "oidc_enabled", type: "boolean", defaultValue: false, visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  oidc_issuer: { key: "oidc_issuer", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  oidc_client_id: { key: "oidc_client_id", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  oidc_client_secret: { key: "oidc_client_secret", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "secret" },
  oidc_scope: { key: "oidc_scope", type: "string", defaultValue: "openid email profile", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_enabled: { key: "saml_enabled", type: "boolean", defaultValue: false, visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_entity_id: { key: "saml_entity_id", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_acs_url: { key: "saml_acs_url", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_sls_url: { key: "saml_sls_url", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_idp_entity_id: { key: "saml_idp_entity_id", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_idp_sso_url: { key: "saml_idp_sso_url", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_idp_slo_url: { key: "saml_idp_slo_url", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "internal" },
  saml_idp_x509cert: { key: "saml_idp_x509cert", type: "string", defaultValue: "", visibility: "excluded", runtime: "excluded", restartRequired: true, sensitivity: "secret" }
};

export const WRITABLE_SETTING_KEYS: readonly WritableSettingKey[] = [
  "store_name", "store_tagline", "store_contact_email", "store_institution",
  "theme_primary_color", "theme_secondary_color", "theme_font_family", "auth_allow_registration"
];

export const SUPPORTED_THEME_FONTS = [
  "system-ui, sans-serif",
  "Inter, ui-sans-serif, system-ui, sans-serif",
  "monospace",
  "ui-monospace, SFMono-Regular, Menlo, monospace"
] as const;

export const DISCOVERY_ABI = "prg32-store-discovery-1.0" as const;
export const DISCOVERY_SERVICE_TYPE = "_prg32store._tcp" as const;
