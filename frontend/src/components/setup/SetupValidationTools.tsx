"use client";

import { useState } from "react";

import { ApiRequestError } from "../../lib/api/client";
import { importSetupSamlMetadata, testSetupSmtpConnection, testSetupSmtpMessage, validateSetupOidc, type SetupStep } from "../../lib/api/setup";

type FormValues = Record<string, string | boolean>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.body?.error ?? error.message;
  return error instanceof Error ? error.message : "The validation request failed.";
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function SetupValidationTools({ step, csrfToken, form, update }: { step: SetupStep; csrfToken: string; form: FormValues; update: (name: string, value: string | boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");

  if (step !== "smtp" && step !== "oidc" && step !== "saml") return null;

  async function run(action: () => Promise<unknown>, successMessage: string) {
    setBusy(true);
    setMessage("");
    setResult("");
    try {
      const response = await action();
      setMessage(successMessage);
      setResult(resultText(response));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const buttonClass = "rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-semibold disabled:opacity-50";

  return <div className="mt-4 grid gap-3 rounded-xl border border-dashed border-[var(--color-border)] p-4">
    <p className="text-sm font-semibold">Validate before saving</p>
    {step === "smtp" ? <>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(() => testSetupSmtpConnection(csrfToken), "SMTP connection accepted.")}>{busy ? "Testing…" : "Test connection"}</button>
      </div>
      <Field label="Test recipient" name="smtp_test_recipient" type="email" value={String(form.smtp_test_recipient ?? "")} onChange={update} help="The message is sent only after an explicit operator action." />
      <button type="button" className={buttonClass} disabled={busy || !String(form.smtp_test_recipient ?? "").trim()} onClick={() => void run(() => testSetupSmtpMessage(csrfToken, String(form.smtp_test_recipient ?? "").trim()), "SMTP test message accepted.")}>{busy ? "Sending…" : "Send test message"}</button>
    </> : null}
    {step === "oidc" ? <button type="button" className={buttonClass} disabled={busy || !String(form.oidc_issuer ?? "").trim()} onClick={() => void run(() => validateSetupOidc(csrfToken, String(form.oidc_issuer ?? "").trim()), "OIDC discovery validated.")}>{busy ? "Validating…" : "Validate OIDC discovery"}</button> : null}
    {step === "saml" ? <>
      <Field label="Metadata URL" name="saml_metadata_url" type="url" value={String(form.saml_metadata_url ?? "")} onChange={update} help="Use a URL or paste XML below. The server validates metadata without persisting it." />
      <label className="grid gap-1 text-sm font-medium" htmlFor="saml_metadata_xml"><span>Metadata XML</span><textarea id="saml_metadata_xml" value={String(form.saml_metadata_xml ?? "")} onChange={(event) => update("saml_metadata_xml", event.target.value)} rows={5} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs" /></label>
      <button type="button" className={buttonClass} disabled={busy || (!String(form.saml_metadata_url ?? "").trim() && !String(form.saml_metadata_xml ?? "").trim())} onClick={() => void run(() => importSetupSamlMetadata(csrfToken, String(form.saml_metadata_xml ?? "").trim() ? { xml: String(form.saml_metadata_xml).trim() } : { url: String(form.saml_metadata_url).trim() }), "SAML metadata validated.")}>{busy ? "Validating…" : "Import and preview metadata"}</button>
    </> : null}
    {message ? <p className="text-sm" role="status">{message}</p> : null}
    {result ? <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--color-background)] p-3 text-xs">{result}</pre> : null}
  </div>;
}

function Field({ label, name, type = "text", value, onChange, help }: { label: string; name: string; type?: string; value: string; onChange: (name: string, value: string) => void; help?: string }) {
  return <label className="grid gap-1 text-sm font-medium" htmlFor={name}>
    <span>{label}</span>
    <input id={name} name={name} type={type} value={value} onChange={(event) => onChange(name, event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal" />
    {help ? <span className="text-xs font-normal text-[var(--color-text-muted)]">{help}</span> : null}
  </label>;
}
