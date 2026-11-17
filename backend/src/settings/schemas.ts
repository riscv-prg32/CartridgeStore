import { LEGACY_SETTING_KEYS, SETTINGS, SUPPORTED_THEME_FONTS, WRITABLE_SETTING_KEYS, type SettingValue, type WritableSettingKey } from "./definitions.js";

export class SettingsValidationError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: "settings_unknown_key" | "settings_read_only" | "settings_excluded" | "settings_asset_managed" | "settings_invalid_value", message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const writableSet = new Set<string>(WRITABLE_SETTING_KEYS);
const legacySet = new Set<string>(LEGACY_SETTING_KEYS);

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsValidationError("settings_invalid_value", "settings patch must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringValue(key: WritableSettingKey, value: unknown): string {
  if (typeof value !== "string") throw new SettingsValidationError("settings_invalid_value", `${key} must be a string`);
  const trimmed = value.trim();
  const definition = SETTINGS[key];
  if (definition.maxLength !== undefined && trimmed.length > definition.maxLength) {
    throw new SettingsValidationError("settings_invalid_value", `${key} is too long`);
  }
  if (key === "store_contact_email" && trimmed && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    throw new SettingsValidationError("settings_invalid_value", "store_contact_email must be a valid email address");
  }
  if ((key === "theme_primary_color" || key === "theme_secondary_color") && !/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    throw new SettingsValidationError("settings_invalid_value", `${key} must use #RRGGBB format`);
  }
  if (key === "theme_font_family" && !SUPPORTED_THEME_FONTS.includes(trimmed as typeof SUPPORTED_THEME_FONTS[number])) {
    throw new SettingsValidationError("settings_invalid_value", "theme_font_family is not supported");
  }
  return (key === "store_contact_email" || key === "theme_primary_color" || key === "theme_secondary_color")
    ? trimmed.toLowerCase()
    : trimmed;
}

export function parseSettingsPatch(value: unknown): Partial<Record<WritableSettingKey, SettingValue>> {
  const payload = record(value);
  const output: Partial<Record<WritableSettingKey, SettingValue>> = {};
  for (const [key, item] of Object.entries(payload)) {
    if (!legacySet.has(key)) throw new SettingsValidationError("settings_unknown_key", `unknown setting: ${key}`);
    if (key === "theme_logo_url" || key === "theme_favicon_url") throw new SettingsValidationError("settings_asset_managed", `${key} is managed through the asset endpoint`);
    const definition = SETTINGS[key as keyof typeof SETTINGS];
    if (!writableSet.has(key) || definition.visibility !== "writable") {
      const code = definition.visibility === "excluded" ? "settings_excluded" : "settings_read_only";
      throw new SettingsValidationError(code, `${key} is not writable`);
    }
    const writableKey = key as WritableSettingKey;
    if (writableKey === "auth_allow_registration") {
      if (typeof item !== "boolean") throw new SettingsValidationError("settings_invalid_value", "auth_allow_registration must be a boolean");
      output[writableKey] = item;
    } else {
      output[writableKey] = stringValue(writableKey, item);
    }
  }
  return output;
}

export function parseStoredValue(key: keyof typeof SETTINGS, raw: string | undefined): SettingValue {
  const definition = SETTINGS[key];
  const fallback = definition.defaultValue ?? "";
  if (raw === undefined) return fallback;
  if (definition.type === "boolean") return raw === "true" ? true : raw === "false" ? false : fallback;
  if (definition.type === "number") {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }
  if (definition.type === "string[]") {
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
    return values.length ? values : fallback;
  }
  return raw;
}
