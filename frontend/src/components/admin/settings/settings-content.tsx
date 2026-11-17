"use client";

import {
  Activity,
  Mail,
  Network,
  Palette,
  PlugZap,
  RadioTower,
  Rocket,
  Send,
  SlidersHorizontal,
  Terminal,
  UserRound,
} from "lucide-react";
import { type Dispatch, type SetStateAction } from "react";

import { Button } from "../../ui/button";
import { HelpTooltip } from "../../ui/help-tooltip";
import { SelectField, SelectItem } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Field } from "../admin-ui";
import type { ManagedAssetKind } from "../../../lib/runtime-assets";
import { EmailTemplatesSection } from "./email-templates";
import type { SettingsSectionId } from "./settings-sections";
import {
  AssetUpload,
  ColorField,
  megabytesValue,
  numberValue,
  readOnlyValue,
  SettingsSection,
  textValue,
  type SettingValues,
} from "./settings-ui";

export type SettingsSectionContentProps = {
  activeSection: SettingsSectionId;
  values: SettingValues;
  typedValues: SettingValues;
  disabled: boolean;
  logoUrl: string;
  faviconUrl: string;
  mdnsInfo: unknown;
  discoveryInfo: unknown;
  emailTemplates: unknown;
  mdnsRuntimeEnabled: boolean;
  setLegacyValue: (key: string, value: unknown) => void;
  setApplicationValue: (key: string, value: unknown) => void;
  onUpload: (kind: ManagedAssetKind, file: File) => Promise<string>;
  onDelete: (kind: ManagedAssetKind) => Promise<void>;
  smtpRecipient: string;
  setSmtpRecipient: Dispatch<SetStateAction<string>>;
  smtpPassword: string;
  setSmtpPassword: Dispatch<SetStateAction<string>>;
  smtpLog: SmtpLogEntry[];
  onTestConnection: () => void;
  onSendTestMessage: () => void;
  testConnectionPending: boolean;
  sendTestMessagePending: boolean;
};

export type SmtpLogEntry = {
  readonly message: string;
  readonly tone: "info" | "success" | "error";
};

function GeneralSection({
  values,
  typedValues,
  setLegacyValue,
  setApplicationValue,
}: Pick<
  SettingsSectionContentProps,
  "values" | "typedValues" | "setLegacyValue" | "setApplicationValue"
>) {
  return (
    <SettingsSection
      icon={SlidersHorizontal}
      title="General"
      description="Define the public identity and contact details of the Cartridge Store."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Store name"
          placeholder="PRG32 Cartridge Store"
          help="Public catalog name used by the backend catalog metadata and the Store identity."
          value={textValue(values, "store_name", "PRG32 Cartridge Store")}
          onChange={(event) => setLegacyValue("store_name", event.target.value)}
        />
        <Field
          label="Store tagline"
          placeholder="Build, publish, repeat."
          help="Short brand line. It is persisted, but it is not currently rendered by the public storefront."
          value={textValue(values, "store_tagline")}
          onChange={(event) => setLegacyValue("store_tagline", event.target.value)}
        />
        <Field
          label="Contact email"
          type="email"
          placeholder="support@example.test"
          help="Public contact address. It is saved in Store settings, but is not currently rendered by the public storefront."
          value={textValue(values, "store_contact_email")}
          onChange={(event) => setLegacyValue("store_contact_email", event.target.value)}
        />
        <Field
          label="Institution"
          placeholder="Università degli Studi di Napoli Parthenope"
          help="Public institutional context. It is persisted, but its storefront rendering is not wired yet."
          value={textValue(values, "store_institution")}
          onChange={(event) => setLegacyValue("store_institution", event.target.value)}
        />
        <Field
          label="Application description"
          placeholder="Discover and download published PRG32 cartridges."
          help="Application-level description stored in typed settings; it is separate from each cartridge description and is not currently rendered by the storefront."
          value={textValue(typedValues, "application.store_description")}
          onChange={(event) =>
            setApplicationValue("application.store_description", event.target.value)
          }
        />
        <Field
          label="Application contact email"
          type="email"
          placeholder="admin@example.test"
          help="Application contact stored in typed settings. It is not the SMTP sender address and is not currently rendered by the storefront."
          value={textValue(typedValues, "application.contact_email")}
          onChange={(event) =>
            setApplicationValue("application.contact_email", event.target.value)
          }
        />
      </div>
    </SettingsSection>
  );
}

function AppearanceSection({
  values,
  logoUrl,
  faviconUrl,
  setLegacyValue,
  onUpload,
  onDelete,
}: Pick<
  SettingsSectionContentProps,
  "values" | "logoUrl" | "faviconUrl" | "setLegacyValue" | "onUpload" | "onDelete"
>) {
  return (
    <SettingsSection
      icon={Palette}
      title="Appearance"
      description="Control the visual defaults used by the public Store interface."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <ColorField
          label="Primary color"
          help="Saved as a public theme token. Storefront color-token wiring is not active yet."
          value={textValue(values, "theme_primary_color", "#7045d8")}
          fallback="#7045d8"
          onChange={(value) => setLegacyValue("theme_primary_color", value)}
        />
        <ColorField
          label="Secondary color"
          help="Saved as a public theme token. Storefront color-token wiring is not active yet."
          value={textValue(values, "theme_secondary_color", "#5931bc")}
          fallback="#5931bc"
          onChange={(value) => setLegacyValue("theme_secondary_color", value)}
        />
        <Field
          label="Font family"
          placeholder="system-ui, sans-serif"
          help="Saved as a public theme token. Storefront font wiring is not active yet."
          value={textValue(values, "theme_font_family", "system-ui, sans-serif")}
          onChange={(event) => setLegacyValue("theme_font_family", event.target.value)}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <AssetUpload kind="logo" currentUrl={logoUrl} onUpload={onUpload} onDelete={onDelete} />
        <AssetUpload kind="favicon" currentUrl={faviconUrl} onUpload={onUpload} onDelete={onDelete} />
      </div>
    </SettingsSection>
  );
}

function RegistrationSection({
  values,
  typedValues,
  disabled,
  setLegacyValue,
  setApplicationValue,
}: Pick<
  SettingsSectionContentProps,
  "values" | "typedValues" | "disabled" | "setLegacyValue" | "setApplicationValue"
>) {
  return (
    <SettingsSection
      icon={UserRound}
      title="Registration and sessions"
      description="Control account creation and the lifetime of authenticated sessions."
    >
      <div className="grid gap-3">
        <Switch
          label="Allow registration"
          help="Controls whether new users can create Cartridge Store accounts. Enforced by the backend."
          description="Let new users create Cartridge Store accounts."
          checked={values.auth_allow_registration === true}
          disabled={disabled}
          onChange={(checked) => setLegacyValue("auth_allow_registration", checked)}
        />
        <Switch
          label="Enable registration workflow"
          help="Controls the canonical registration policy used by the backend."
          description="Enable the canonical registration policy."
          checked={typedValues["registration.enabled"] === true}
          disabled={disabled}
          onChange={(checked) => setApplicationValue("registration.enabled", checked)}
        />
        <Switch
          label="Require email verification"
          help="Requires a verified email before an account becomes active. Enforced by the backend."
          description="Require a verified email before an account becomes active."
          checked={typedValues["registration.require_email_verification"] === true}
          disabled={disabled}
          onChange={(checked) =>
            setApplicationValue("registration.require_email_verification", checked)
          }
        />
      </div>
      <Field
        label="Session lifetime (seconds)"
        type="number"
        min={60}
        placeholder="86400"
        help="Maximum lifetime of a signed-in session, in seconds. Enforced by the backend."
        value={String(numberValue(typedValues, "session.lifetime_seconds", 86400))}
        onChange={(event) =>
          setApplicationValue("session.lifetime_seconds", Number(event.target.value))
        }
      />
    </SettingsSection>
  );
}

function PublishingSection({
  typedValues,
  disabled,
  setApplicationValue,
}: Pick<SettingsSectionContentProps, "typedValues" | "disabled" | "setApplicationValue">) {
  return (
    <SettingsSection
      icon={Rocket}
      title="Publishing and review"
      description="Control whether cartridges can be submitted and how review decisions are recorded."
    >
      <div className="grid gap-3">
        <Switch
          label="Enable publishing"
          help="Controls whether publishers can submit cartridge bundles. Enforced by the backend."
          description="Allow publishers to submit cartridge bundles for validation."
          checked={typedValues["publishing.enabled"] === true}
          disabled={disabled}
          onChange={(checked) => setApplicationValue("publishing.enabled", checked)}
        />
        <Switch
          label="Require a note when rejecting"
          help="Requires reviewers to explain requested changes when rejecting a submission. Enforced by the backend."
          description="Ask reviewers to explain requested changes."
          checked={typedValues["review.require_note_on_rejection"] === true}
          disabled={disabled}
          onChange={(checked) =>
            setApplicationValue("review.require_note_on_rejection", checked)
          }
        />
      </div>
      <label className="grid gap-1 text-sm font-medium" htmlFor="publishing-max-artifact-size">
        <span className="flex items-center gap-1.5">
          Maximum artifact size
          <HelpTooltip
            label="Maximum artifact size"
            text="Maximum bundle size accepted by backend validation."
          />
        </span>
        <div className="flex">
          <input
            id="publishing-max-artifact-size"
            aria-describedby="publishing-max-artifact-size-help"
            className="min-h-10 min-w-0 flex-1 rounded-l-md border border-r-0 border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal text-[var(--color-text)]"
            type="number"
            min={0.01}
            step={0.5}
            placeholder="50"
            disabled={disabled}
            value={String(megabytesValue(typedValues, "publishing.max_artifact_bytes", 52428800))}
            onChange={(event) => {
              const megabytes = Number(event.target.value);
              setApplicationValue(
                "publishing.max_artifact_bytes",
                Number.isFinite(megabytes) && megabytes > 0
                  ? Math.round(megabytes * 1024 * 1024)
                  : 0,
              );
            }}
          />
          <span className="grid min-w-14 place-items-center rounded-r-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 text-sm font-semibold text-[var(--color-text-muted)]">
            MB
          </span>
        </div>
        <span id="publishing-max-artifact-size-help" className="text-xs font-normal leading-5 text-[var(--color-text-muted)]">
          Maximum size allowed for an uploaded cartridge bundle.
        </span>
      </label>
    </SettingsSection>
  );
}

function TelemetrySection({
  typedValues,
  disabled,
  setApplicationValue,
}: Pick<SettingsSectionContentProps, "typedValues" | "disabled" | "setApplicationValue">) {
  return (
    <SettingsSection
      icon={Activity}
      title="Telemetry"
      description="Choose which optional runtime telemetry and security notifications are active."
    >
      <div className="grid gap-3">
        <Switch
          label="Collect telemetry"
          help="Allows compatible clients to submit runtime metrics and run samples. Enforced by the backend."
          description="Accept runtime metrics and run samples from compatible clients."
          checked={typedValues["telemetry.collection_enabled"] === true}
          disabled={disabled}
          onChange={(checked) => setApplicationValue("telemetry.collection_enabled", checked)}
        />
        <Switch
          label="Notify users about account changes"
          help="Controls security notifications for account changes. The setting is stored, but notification delivery is not currently wired."
          description="Send security notifications when account data changes."
          checked={typedValues["security.notify_user_on_account_change"] === true}
          disabled={disabled}
          onChange={(checked) =>
            setApplicationValue("security.notify_user_on_account_change", checked)
          }
        />
      </div>
    </SettingsSection>
  );
}

function DiscoverySection({
  typedValues,
  disabled,
  mdnsInfo,
  discoveryInfo,
  mdnsRuntimeEnabled,
  setApplicationValue,
}: Pick<
  SettingsSectionContentProps,
  | "typedValues"
  | "disabled"
  | "mdnsInfo"
  | "discoveryInfo"
  | "mdnsRuntimeEnabled"
  | "setApplicationValue"
>) {
  return (
    <SettingsSection
      icon={RadioTower}
      title="Discovery"
      description="Manage local mDNS discovery and inspect the fixed PRG32 discovery contract."
    >
      <div className="rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-primary-soft)]/45 p-5">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-[var(--color-surface)] text-[var(--color-primary-strong)]">
              <Network aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="technical-label text-[var(--color-primary-strong)]">Local network discovery</p>
              <h3 className="mt-1 text-lg font-bold">Find the Cartridge Store on your network.</h3>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
                Save the preference to start or stop the local mDNS advertisement without restarting the backend.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-3 lg:min-w-64">
            <span
              className={[
                "inline-flex items-center gap-2 self-start rounded-full px-3 py-1 text-xs font-semibold",
                mdnsRuntimeEnabled
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-[var(--color-surface)] text-[var(--color-text-muted)]",
              ].join(" ")}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {mdnsRuntimeEnabled ? "Advertised" : "Not advertised"}
            </span>
            <Switch
              label="Enable mDNS discovery"
              help="Advertises this Store on the local network using the fixed PRG32 discovery contract."
              description="Advertise this Store on the local network when saved."
              checked={typedValues["discovery.mdns_enabled"] === true}
              disabled={disabled}
              onChange={(checked) => setApplicationValue("discovery.mdns_enabled", checked)}
            />
          </div>
        </div>
        <dl className="mt-6 grid gap-4 border-t border-[var(--color-primary)]/15 pt-4 sm:grid-cols-3">
          <div>
            <dt className="technical-label text-[var(--color-text-muted)]">Service type</dt>
            <dd className="mt-1 font-mono text-sm font-semibold">
              {readOnlyValue(mdnsInfo, "service_type", "_prg32store._tcp")}
            </dd>
          </div>
          <div>
            <dt className="technical-label text-[var(--color-text-muted)]">Discovery ABI</dt>
            <dd className="mt-1 font-mono text-sm font-semibold">
              {readOnlyValue(discoveryInfo, "abi", "prg32-store-discovery-1.0")}
            </dd>
          </div>
          <div>
            <dt className="technical-label text-[var(--color-text-muted)]">Port</dt>
            <dd className="mt-1 font-mono text-sm font-semibold">
              {readOnlyValue(mdnsInfo, "port", "5080")}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">
          The deployment must allow mDNS before this preference can be enabled. The current runtime state is shown above.
        </p>
      </div>
    </SettingsSection>
  );
}

function EmailSection({
  typedValues,
  disabled,
  setApplicationValue,
  smtpRecipient,
  setSmtpRecipient,
  smtpPassword,
  setSmtpPassword,
  smtpLog,
  onTestConnection,
  onSendTestMessage,
  testConnectionPending,
  sendTestMessagePending,
}: Pick<
  SettingsSectionContentProps,
  | "typedValues"
  | "disabled"
  | "setApplicationValue"
  | "smtpRecipient"
  | "setSmtpRecipient"
  | "smtpPassword"
  | "setSmtpPassword"
  | "smtpLog"
  | "onTestConnection"
  | "onSendTestMessage"
  | "testConnectionPending"
  | "sendTestMessagePending"
>) {
  const securityMode = typedValues["smtp.secure"] === true || typedValues["smtp.encryption"] === "implicit_tls"
    ? "tls"
    : typedValues["smtp.encryption"] === "starttls"
      ? "starttls"
      : "none";

  function setSecurityMode(mode: string) {
    setApplicationValue("smtp.secure", mode === "tls");
    setApplicationValue("smtp.encryption", mode === "tls" ? "implicit_tls" : mode);
  }

  return (
    <SettingsSection
      icon={Mail}
      title="Email delivery"
      description="Configure SMTP delivery for transactional and security messages. Secrets remain write-only."
    >
      <div className="grid gap-3">
        <Switch
          label="Enable SMTP"
          help="Allows transactional and security email to be delivered through the configured SMTP server."
          description="Allow the service to deliver email through the configured SMTP server."
          checked={typedValues["smtp.enabled"] === true}
          disabled={disabled}
          onChange={(checked) => setApplicationValue("smtp.enabled", checked)}
        />
      </div>
      <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
        <div>
          <p className="technical-label text-[var(--color-primary)]">SMTP server</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">Choose where the Store connects and how the connection is secured.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="SMTP host" placeholder="mailpit" help="Hostname or IP address of the SMTP server. In local development this is commonly the shared Mailpit hostname." value={textValue(typedValues, "smtp.host")} onChange={(event) => setApplicationValue("smtp.host", event.target.value)} />
          <Field label="SMTP port" type="number" placeholder="1025" help="TCP port exposed by the SMTP server. Mailpit commonly uses 1025 in development." value={String(numberValue(typedValues, "smtp.port", 1025))} onChange={(event) => setApplicationValue("smtp.port", Number(event.target.value))} />
          <SelectField
            label="Connection security"
            name="smtp-security"
            value={securityMode}
            onValueChange={setSecurityMode}
            disabled={disabled}
            description="Choose plain SMTP, STARTTLS, or implicit TLS."
            help="Plain SMTP sends without TLS; STARTTLS upgrades the connection; TLS / SSL starts encrypted immediately."
          >
            <SelectItem value="none">Plain SMTP</SelectItem>
            <SelectItem value="starttls">STARTTLS</SelectItem>
            <SelectItem value="tls">TLS / SSL</SelectItem>
          </SelectField>
        </div>
      </div>
      <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
        <div>
          <p className="technical-label text-[var(--color-primary)]">Authentication</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">Keep the SMTP username and password together. Leave authentication off for Mailpit.</p>
        </div>
        <Switch
          label="Enable SMTP authentication"
          help="Authenticates with the configured SMTP username and password. Leave it off for Mailpit."
          description="Authenticate with the configured SMTP username and password."
          checked={typedValues["smtp.auth_enabled"] === true}
          disabled={disabled}
          onChange={(checked) => setApplicationValue("smtp.auth_enabled", checked)}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="SMTP username" placeholder="smtp-user" help="Username sent to the SMTP server when authentication is enabled." value={textValue(typedValues, "smtp.username")} onChange={(event) => setApplicationValue("smtp.username", event.target.value)} />
          <Field label="SMTP password" type="password" value={smtpPassword} placeholder="Leave blank to keep the saved password" help="Write-only SMTP credential. Leave blank to keep the existing saved password." autoComplete="new-password" onChange={(event) => setSmtpPassword(event.target.value)} />
        </div>
      </div>
      <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
        <div>
          <p className="technical-label text-[var(--color-primary)]">Sender identity</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">Set the name and addresses used by transactional messages.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="From name" placeholder="PRG32 Cartridge Store" help="Display name shown as the sender of transactional messages." value={textValue(typedValues, "smtp.from_name", "PRG32 Cartridge Store")} onChange={(event) => setApplicationValue("smtp.from_name", event.target.value)} />
          <Field label="From email" type="email" placeholder="no-reply@example.test" help="Email address used in the From header of transactional messages." value={textValue(typedValues, "smtp.from_email")} onChange={(event) => setApplicationValue("smtp.from_email", event.target.value)} />
          <Field label="Reply-to" type="email" placeholder="support@example.test" help="Optional address that receives replies to transactional messages." value={textValue(typedValues, "smtp.reply_to")} onChange={(event) => setApplicationValue("smtp.reply_to", event.target.value)} />
        </div>
      </div>
      <div className="grid items-stretch gap-6 border-t border-[var(--color-border)] pt-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex h-full flex-col">
          <div>
            <p className="technical-label text-[var(--color-primary)]">Connection check</p>
            <h3 className="mt-1 text-sm font-semibold">Verify the SMTP server</h3>
            <p className="mt-1 max-w-md text-sm leading-6 text-[var(--color-text-muted)]">Check the server handshake without sending an email.</p>
          </div>
          <div className="mt-auto pt-4">
            <Button disabled={testConnectionPending} onClick={onTestConnection}>
              <PlugZap aria-hidden="true" className="size-4" />
              {testConnectionPending ? "Testing…" : "Test SMTP connection"}
            </Button>
          </div>
        </div>
        <div className="flex h-full flex-col">
          <div>
            <p className="technical-label text-[var(--color-primary)]">Message delivery</p>
            <h3 className="mt-1 text-sm font-semibold">Send a test message</h3>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">Choose a recipient to verify the complete delivery path.</p>
          </div>
          <div className="mt-auto flex flex-col gap-3 pt-4 sm:flex-row sm:items-end">
            <Field className="min-w-0 flex-1" label="Test recipient" type="email" placeholder="admin@example.test" help="Recipient for the manual SMTP test message. It is used only when you click Send test message." value={smtpRecipient} onChange={(event) => setSmtpRecipient(event.target.value)} />
            <Button variant="secondary" className="sm:shrink-0" disabled={!smtpRecipient || sendTestMessagePending} onClick={onSendTestMessage}>
              <Send aria-hidden="true" className="size-4" />
              {sendTestMessagePending ? "Sending…" : "Send test message"}
            </Button>
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
        <div className="flex items-center gap-2">
          <Terminal aria-hidden="true" className="size-4 text-[var(--color-primary-strong)]" />
          <h3 className="text-sm font-semibold">Connection log</h3>
        </div>
        <div className="mt-3 min-h-20 rounded-md bg-[var(--color-text)] p-3 font-mono text-xs leading-6 text-white" aria-live="polite">
          {smtpLog.length > 0 ? smtpLog.map((entry, index) => (
            <p
              className={entry.tone === "error" ? "text-red-300" : entry.tone === "success" ? "text-emerald-300" : "text-white"}
              key={`${entry.message}-${index}`}
            >
              {entry.message}
            </p>
          )) : <p className="text-white/60">No connection tests run yet.</p>}
        </div>
      </div>
    </SettingsSection>
  );
}


export function SettingsSectionContent(props: SettingsSectionContentProps) {
  switch (props.activeSection) {
    case "general":
      return <GeneralSection {...props} />;
    case "appearance":
      return <AppearanceSection {...props} />;
    case "registration":
      return <RegistrationSection {...props} />;
    case "publishing":
      return <PublishingSection {...props} />;
    case "telemetry":
      return <TelemetrySection {...props} />;
    case "discovery":
      return <DiscoverySection {...props} />;
    case "email":
      return <EmailSection {...props} />;
    case "email-templates":
      return <EmailTemplatesSection {...props} />;
  }
}
