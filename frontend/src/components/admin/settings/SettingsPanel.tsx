"use client";

import { CheckCircle2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../ui/button";
import { Notice } from "../admin-ui";
import { publicApiPath } from "../../../lib/api/origin";
import type { ManagedAssetKind } from "../../../lib/runtime-assets";
import { StatusMessage } from "../../ui/status";
import type { SettingsSectionId } from "./settings-sections";
import {
  SettingsSectionContent,
  type SmtpLogEntry,
} from "./settings-content";
import {
  dispatchManagedAssetUpdated,
  readOnlyValue,
  type SettingValues,
} from "./settings-ui";
import { useAdminSettings } from "./use-settings";

export function SettingsPanel({
  section,
}: {
  section?: SettingsSectionId;
}) {
  const activeSection = section ?? "general";
  const { query, update, testConnection, sendTestMessage, uploadAsset, deleteAsset } =
    useAdminSettings();
  const [draft, setDraft] = useState<SettingValues>({});
  const [typedDraft, setTypedDraft] = useState<SettingValues>({});
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpRecipient, setSmtpRecipient] = useState("admin@example.test");
  const [smtpLog, setSmtpLog] = useState<SmtpLogEntry[]>([]);
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (!success) return;
    const timeout = window.setTimeout(() => setSuccess(""), 3500);
    return () => window.clearTimeout(timeout);
  }, [success]);

  const initialValues = useMemo(
    () =>
      query.data
        ? Object.fromEntries(
            Object.entries(query.data.settings)
              .filter(([, setting]) => setting.writable)
              .map(([key, setting]) => [key, setting.value]),
          )
        : {},
    [query.data],
  );
  const initialTypedValues = useMemo(
    () =>
      query.data
        ? Object.fromEntries(
            Object.entries(query.data.application_settings ?? {}).map(
              ([key, setting]) => [key, setting.value],
            ),
          )
        : {},
    [query.data],
  );
  const values = Object.keys(draft).length ? draft : initialValues;
  const typedValues = Object.keys(typedDraft).length ? typedDraft : initialTypedValues;
  const mdnsInfo = query.data?.read_only?.mdns;
  const discoveryInfo = query.data?.read_only?.discovery;
  const emailTemplates = query.data?.read_only?.email_templates;
  const resolveAssetSetting = (value: unknown) => {
    const url = String(value ?? "");
    return url.startsWith("/api/assets/") ? publicApiPath(url) : url;
  };
  const logoUrl = resolveAssetSetting(query.data?.settings.theme_logo_url?.value);
  const faviconUrl = resolveAssetSetting(query.data?.settings.theme_favicon_url?.value);
  const mdnsRuntimeEnabled = readOnlyValue(mdnsInfo, "enabled", "false") === "true";
  const error =
    query.error ??
    update.error ??
    uploadAsset.error ??
    deleteAsset.error;
  const disabled = query.isLoading || update.isPending;

  function setLegacyValue(key: string, value: unknown) {
    setDraft((current) => ({ ...values, ...current, [key]: value }));
  }

  function setApplicationValue(key: string, value: unknown) {
    setTypedDraft((current) => ({ ...typedValues, ...current, [key]: value }));
  }

  function changedValues(current: SettingValues, initial: SettingValues): SettingValues {
    return Object.fromEntries(
      Object.entries(current).filter(([key, value]) => !Object.is(value, initial[key])),
    );
  }

  function saveSettings() {
    setSuccess("");
    const applicationSettings = {
      ...changedValues(typedValues, initialTypedValues),
      ...(smtpPassword ? { "smtp.password": smtpPassword } : {}),
    };
    update.mutate(
      { ...changedValues(values, initialValues), application_settings: applicationSettings },
      {
        onSuccess: () => {
          setSmtpPassword("");
          setSuccess("Settings saved.");
        },
      },
    );
  }

  function appendSmtpLog(message: string, tone: SmtpLogEntry["tone"] = "info") {
    const timestamp = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
    setSmtpLog((current) => [...current, { message: `[${timestamp}] ${message}`, tone }].slice(-8));
  }

  function smtpErrorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  function testSmtpConnection() {
    setSuccess("");
    appendSmtpLog("Starting SMTP connection test.");
    testConnection.mutate(undefined, {
      onSuccess: () => {
        appendSmtpLog("SMTP connection accepted.", "success");
      },
      onError: (error) => {
        const message = smtpErrorMessage(error, "SMTP connection failed.");
        appendSmtpLog(message, "error");
      },
    });
  }

  function sendSmtpTestMessage() {
    setSuccess("");
    appendSmtpLog(`Sending test message to ${smtpRecipient}.`);
    sendTestMessage.mutate(smtpRecipient, {
      onSuccess: () => {
        appendSmtpLog("SMTP test message accepted.", "success");
      },
      onError: (error) => {
        const message = smtpErrorMessage(error, "SMTP test message failed.");
        appendSmtpLog(message, "error");
      },
    });
  }

  async function uploadManagedAsset(kind: ManagedAssetKind, file: File) {
    const response = await uploadAsset.mutateAsync({ kind, file });
    const assetUrl = publicApiPath(response.asset.url);
    dispatchManagedAssetUpdated(kind, assetUrl);
    return assetUrl;
  }

  async function deleteManagedAsset(kind: ManagedAssetKind) {
    await deleteAsset.mutateAsync(kind);
    dispatchManagedAssetUpdated(kind, "");
  }

  return (
    <div className="space-y-6">
      <Notice error={error} />
      {success ? (
        <div className="pointer-events-none fixed inset-x-4 top-24 z-50 flex justify-end sm:right-6 sm:left-auto">
          <StatusMessage
            tone="success"
            aria-live="polite"
            className="flex items-center gap-2 px-3 py-2 shadow-lg"
          >
            <CheckCircle2 aria-hidden="true" className="size-4" />
            {success}
          </StatusMessage>
        </div>
      ) : null}
      {query.isLoading ? (
        <p>Loading settings…</p>
      ) : (
        <div className="space-y-4">
          <SettingsSectionContent
            activeSection={activeSection}
            values={values}
            typedValues={typedValues}
            disabled={disabled}
            logoUrl={logoUrl}
            faviconUrl={faviconUrl}
            mdnsInfo={mdnsInfo}
            discoveryInfo={discoveryInfo}
            emailTemplates={emailTemplates}
            mdnsRuntimeEnabled={mdnsRuntimeEnabled}
            setLegacyValue={setLegacyValue}
            setApplicationValue={setApplicationValue}
            onUpload={uploadManagedAsset}
            onDelete={deleteManagedAsset}
            smtpRecipient={smtpRecipient}
            setSmtpRecipient={setSmtpRecipient}
            smtpPassword={smtpPassword}
            setSmtpPassword={setSmtpPassword}
            smtpLog={smtpLog}
            onTestConnection={testSmtpConnection}
            onSendTestMessage={sendSmtpTestMessage}
            testConnectionPending={testConnection.isPending}
            sendTestMessagePending={sendTestMessage.isPending}
          />
          <div className="flex justify-end pt-2">
            <Button disabled={update.isPending} onClick={saveSettings}>
              <Save aria-hidden="true" className="size-4" />
              {update.isPending ? "Saving…" : activeSection === "email-templates" ? "Save template" : "Save settings"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
