"use client";

import { Mail, MailOpen } from "lucide-react";
import Image from "next/image";
import { useState } from "react";

import { SettingsSection, textValue, type SettingValues } from "./settings-ui";

type EmailTemplatePreview = {
  id: string;
  name: string;
  description: string;
  variables: string[];
  subject: string;
  text: string;
  action?: {
    label: string;
    href: string;
  };
};

function templatePreviews(value: unknown): EmailTemplatePreview[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.subject !== "string" || typeof item.text !== "string") return [];
    const action = item.action && typeof item.action === "object" && !Array.isArray(item.action)
      ? item.action as Record<string, unknown>
      : undefined;
    const parsedAction = typeof action?.label === "string" && typeof action.href === "string" && /^https?:\/\//.test(action.href)
      ? { label: action.label, href: action.href }
      : undefined;
    return [{
      id: item.id,
      name: item.name,
      description: typeof item.description === "string" ? item.description : "",
      variables: Array.isArray(item.variables) ? item.variables.filter((variable): variable is string => typeof variable === "string") : [],
      subject: item.subject,
      text: item.text,
      ...(parsedAction === undefined ? {} : { action: parsedAction }),
    }];
  });
}
export type EmailTemplatesSectionProps = {
  emailTemplates: unknown;
  logoUrl: string;
  typedValues: SettingValues;
  disabled: boolean;
  setApplicationValue: (key: string, value: unknown) => void;
};

export function EmailTemplatesSection({
  emailTemplates,
  logoUrl,
  typedValues,
  disabled,
  setApplicationValue,
}: EmailTemplatesSectionProps) {
  const templates = templatePreviews(emailTemplates);
  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  const selected = templates.find((template) => template.id === selectedId) ?? templates[0];
  const managedLogo = logoUrl || "/prg32_logo_transparent.png";
  const [failedLogo, setFailedLogo] = useState("");
  const previewLogo = failedLogo === managedLogo ? "/prg32_logo_transparent.png" : managedLogo;
  const subjectKey = selected?.id === "smtp_test" ? "email.smtp_test_subject" : "email.approval_subject";
  const bodyKey = selected?.id === "smtp_test" ? "email.smtp_test_body" : "email.approval_body";
  const subjectValue = selected ? textValue(typedValues, subjectKey, selected.subject) : "";
  const bodyValue = selected ? textValue(typedValues, bodyKey, selected.text) : "";
  const previewSubject = selected ? interpolateEmailPreview(subjectValue) : "";
  const previewBody = selected ? previewEmailBody(bodyValue, selected.id) : "";

  return (
    <SettingsSection
      icon={MailOpen}
      title="Email templates"
      description="Choose a message to understand when it is sent, who receives it, and what the final email looks like."
    >
      {templates.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No email templates are available.</p>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="surface-card p-4" aria-label="Email template library">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3">
              <div>
                <p className="technical-label text-[var(--color-primary)]">Library</p>
                <h3 className="mt-1 font-bold">Message types</h3>
              </div>
              <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-1 text-xs font-bold text-[var(--color-primary-strong)]">{templates.length}</span>
            </div>
            <div className="mt-3 space-y-2" role="tablist" aria-label="Email templates">
              {templates.map((template) => {
                const active = template.id === selected?.id;
                const isTest = template.id === "smtp_test";
                return (
                  <button
                    key={template.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedId(template.id)}
                    className={[
                      "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition",
                      active
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                        : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]",
                    ].join(" ")}
                  >
                    <span className={["grid size-8 shrink-0 place-items-center rounded-md", active ? "bg-[var(--color-primary)] text-white" : "bg-[var(--color-surface-muted)] text-[var(--color-primary-strong)]"].join(" ")}>
                      <MailOpen aria-hidden="true" className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold">{template.name}</span>
                      <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">{isTest ? "Manual delivery check" : "Submission approved"}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
              <p className="text-xs font-semibold">How to read this page</p>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Select a template to inspect its trigger, recipient, subject, and rendered body.</p>
            </div>
          </aside>

          {selected && (
            <div className="min-w-0 space-y-5">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
                <div>
                  <p className="technical-label text-[var(--color-primary)]">Selected template</p>
                  <h3 className="mt-1 text-xl font-bold">{selected.name}</h3>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">{selected.description}</p>
                </div>
                <span className="w-fit rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)]">{selected.id === "smtp_test" ? "Manual test" : "Workflow notification"}</span>
              </div>

              <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5" aria-labelledby="email-template-editor-heading">
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div>
                    <p className="technical-label text-[var(--color-primary)]">Template editor</p>
                    <h4 id="email-template-editor-heading" className="mt-1 font-bold">Edit this message</h4>
                    <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">Change only the subject and message body. The secure Store branding and action button stay managed by the platform.</p>
                  </div>
                  <span className="w-fit rounded-full bg-[var(--color-primary-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--color-primary-strong)]">Editable</span>
                </div>
                <div className="mt-5 grid gap-4">
                  <label className="grid gap-1.5 text-sm font-semibold" htmlFor="email-template-subject">
                    Subject line
                    <input
                      id="email-template-subject"
                      className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-soft)]"
                      disabled={disabled}
                      value={subjectValue}
                      onChange={(event) => setApplicationValue(subjectKey, event.target.value)}
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm font-semibold" htmlFor="email-template-body">
                    Message body
                    <textarea
                      id="email-template-body"
                      className="min-h-36 resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal leading-6 text-[var(--color-text)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-soft)]"
                      disabled={disabled}
                      rows={7}
                      value={bodyValue}
                      onChange={(event) => setApplicationValue(bodyKey, event.target.value)}
                    />
                  </label>
                  <p className="text-xs leading-5 text-[var(--color-text-muted)]">Use the variables shown in Available variables, for example <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5">{"{{gameTitle}}"}</code>. HTML is not accepted in the body.</p>
                  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4" aria-labelledby="email-template-variables-heading">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                      <div>
                        <p id="email-template-variables-heading" className="technical-label text-[var(--color-primary)]">Available variables</p>
                        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Values filled from the submission, publisher, or Store configuration when the message is sent.</p>
                      </div>
                      <span className="text-xs font-semibold text-[var(--color-text-muted)]">{selected.variables.length} available</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selected.variables.map((variable) => <code key={variable} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-primary-strong)]">{`{{${variable}}}`}</code>)}
                    </div>
                  </div>
                </div>
              </section>

              <article className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
                <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3 sm:px-5">
                  <div>
                    <p className="technical-label text-[var(--color-primary)]">Inbox preview</p>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">This is the message layout the recipient will receive.</p>
                  </div>
                  <Mail aria-hidden="true" className="size-5 text-[var(--color-text-muted)]" />
                </div>
                <div className="bg-white p-5 text-[var(--color-text)] sm:p-7">
                  <div className="mb-5 flex items-center gap-3 border-b border-slate-200 pb-5">
                    <span className="relative grid h-11 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-slate-950">
                      <Image
                        src={previewLogo}
                        alt="PRG32"
                        width={64}
                        height={44}
                        unoptimized
                        onError={() => setFailedLogo(managedLogo)}
                        className="h-11 w-16 object-contain"
                      />
                    </span>
                    <div>
                      <p className="text-sm font-bold text-slate-900">PRG32 Cartridge Store</p>
                      <p className="mt-0.5 text-xs text-slate-500">Transactional message</p>
                    </div>
                  </div>
                  <dl className="grid gap-2 border-b border-slate-200 pb-5 text-sm sm:grid-cols-[4rem_minmax(0,1fr)] sm:gap-x-4">
                    <dt className="font-semibold text-slate-500">From</dt>
                    <dd>PRG32 Cartridge Store</dd>
                    <dt className="font-semibold text-slate-500">To</dt>
                    <dd>{selected.id === "smtp_test" ? "Configured test recipient" : "Ivan · publisher"}</dd>
                    <dt className="font-semibold text-slate-500">Subject</dt>
                    <dd className="font-bold sm:col-span-1">{previewSubject}</dd>
                  </dl>
                  <p className="whitespace-pre-wrap pt-6 text-sm leading-7 text-slate-700">{previewBody}</p>
                  {selected.action && (
                    <div className="pt-7">
                      <a
                        href={selected.action.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 border-2 border-[#171225] bg-[#b8f34a] px-4 py-3 text-xs font-extrabold uppercase tracking-[0.12em] text-[#171225] shadow-[4px_4px_0_#171225] transition-transform hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-[2px_2px_0_#171225] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7044dc]"
                      >
                        <span aria-hidden="true">▶</span>
                        {selected.action.label}
                      </a>
                    </div>
                  )}
                </div>
              </article>

              <div>
                <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5" aria-labelledby="template-trigger-heading">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                    <div className="flex items-baseline gap-3">
                      <p className="technical-label text-[var(--color-primary)]">Trigger</p>
                      <h4 id="template-trigger-heading" className="font-bold">{selected.id === "smtp_test" ? "Sent manually" : "Submission approved"}</h4>
                    </div>
                    <p className="text-sm leading-6 text-[var(--color-text-muted)]">{selected.id === "smtp_test" ? "Sent from Email delivery when you choose a test recipient." : "Sent after an administrator approves a publisher submission."}</p>
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function interpolateEmailPreview(value: string): string {
  const publicOrigin = process.env.NEXT_PUBLIC_PRG32_STORE_ORIGIN?.trim() || "https://store.prg32.test";
  const publicUrl = `${publicOrigin.replace(/\/$/u, "")}/games/it.uniparthenope.asteroids?version=1.0.0`;
  const sampleValues: Record<string, string> = {
    recipientName: "Ivan",
    gameTitle: "Asteroids",
    gameId: "it.uniparthenope.asteroids",
    version: "1.0.0",
    reviewerName: "Store administrator",
    storeName: "PRG32 Cartridge Store",
    publicOrigin,
    publicUrl,
  };
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key: string) => sampleValues[key] ?? "");
}

function previewEmailBody(value: string, templateId: string): string {
  const body = interpolateEmailPreview(value);
  if (templateId === "smtp_test") return "Hello,\n\n" + body + "\n\n— PRG32 Cartridge Store";
  const publicOrigin = process.env.NEXT_PUBLIC_PRG32_STORE_ORIGIN?.trim() || "https://store.prg32.test";
  return "Hi Ivan,\n\n" + body + `\n\nView it in the public catalog: ${publicOrigin.replace(/\/$/u, "")}/games/it.uniparthenope.asteroids?version=1.0.0` + "\nReviewed by: Store administrator\nGame ID: it.uniparthenope.asteroids\n\n— PRG32 Cartridge Store";
}
