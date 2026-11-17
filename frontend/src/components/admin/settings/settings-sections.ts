/** Canonical settings pages exposed by the developer dashboard. */
export type SettingsSectionId =
  | "general"
  | "appearance"
  | "registration"
  | "publishing"
  | "telemetry"
  | "discovery"
  | "email"
  | "email-templates";

export const settingsSectionMetadata: Record<
  SettingsSectionId,
  { title: string; description: string }
> = {
  general: {
    title: "General",
    description:
      "Define the public identity and contact details of the Cartridge Store.",
  },
  appearance: {
    title: "Appearance",
    description:
      "Control the visual defaults used by the public Store interface.",
  },
  registration: {
    title: "Registration and sessions",
    description:
      "Control account creation and the lifetime of authenticated sessions.",
  },
  publishing: {
    title: "Publishing and review",
    description:
      "Control whether cartridges can be submitted and how review decisions are recorded.",
  },
  telemetry: {
    title: "Telemetry",
    description:
      "Choose which optional runtime telemetry and security notifications are active.",
  },
  discovery: {
    title: "Discovery",
    description:
      "Manage local mDNS discovery and inspect the fixed PRG32 discovery contract.",
  },
  email: {
    title: "Email delivery",
    description:
      "Configure SMTP delivery for transactional and security messages. Secrets remain write-only.",
  },
  "email-templates": {
    title: "Email templates",
    description:
      "Preview the messages sent to publishers when their cartridge submissions change state.",
  },
};

/** Returns whether a route segment identifies a supported settings page. */
export function isSettingsSection(value: string): value is SettingsSectionId {
  return value in settingsSectionMetadata;
}
