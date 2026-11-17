"use client";

import {
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";

import { federationErrorMessage } from "../../lib/api/federation-admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";

/** Shared panel layout for federation administration sections. */
export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section
      className={[
        "rounded-xl border border-[var(--color-border)]",
        "bg-[var(--color-surface)] p-5 shadow-sm",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** Displays a federation operation error or success message. */
export function Notice({
  error,
  success,
}: {
  error?: unknown;
  success?: string;
}) {
  if (error) {
    return (
      <StatusMessage tone="danger" className="px-3 py-2">
        {federationErrorMessage(error)}
      </StatusMessage>
    );
  }
  if (success) {
    return (
      <StatusMessage tone="success" className="px-3 py-2">
        {success}
      </StatusMessage>
    );
  }
  return null;
}

/** Styled text input with an optional explanatory hint. */
export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      <span>
        {label}
        {props.required && <span className="text-rose-700"> *</span>}
      </span>
      <input
        {...props}
        className={[
          "min-h-10 rounded-md border border-[var(--color-border)]",
          "bg-[var(--color-surface)] px-3 py-2 font-normal",
          "text-[var(--color-text)]",
        ].join(" ")}
      />
      {hint && (
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

/** Styled textarea with an optional explanatory hint. */
export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium">
      <span>
        {label}
        {props.required && <span className="text-rose-700"> *</span>}
      </span>
      <textarea
        {...props}
        className={[
          "min-h-28 rounded-md border border-[var(--color-border)]",
          "bg-[var(--color-surface)] px-3 py-2 font-mono text-xs font-normal",
          "text-[var(--color-text)]",
        ].join(" ")}
      />
      {hint && (
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          {hint}
        </span>
      )}
    </label>
  );
}

/** Shows enabled/disabled or complete/incomplete state. */
export function StatusBadge({
  enabled,
  complete,
}: {
  enabled?: boolean;
  complete?: boolean;
}) {
  const text =
    enabled !== undefined
      ? enabled
        ? "Enabled"
        : "Disabled"
      : complete
        ? "Complete"
        : "Incomplete";
  return (
    <Badge
      variant={
        text === "Enabled" || text === "Complete" ? "success" : "warning"
      }
    >
      {text}
    </Badge>
  );
}

/** Displays and optionally opens a canonical federation endpoint. */
export function Endpoint({
  label,
  value,
  link,
}: {
  label: string;
  value: string;
  link?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={[
        "flex flex-wrap items-center gap-2",
        "border-b border-[var(--color-border)] py-2 last:border-0",
      ].join(" ")}
    >
      <span className="w-32 text-sm font-semibold">{label}</span>
      <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
      <Button
        variant="secondary"
        className="min-h-8 px-2 py-1 text-xs"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      {link && (
        <a
          className="text-xs font-semibold text-violet-700 hover:underline"
          href={link}
          target="_blank"
          rel="noreferrer"
        >
          Open
        </a>
      )}
    </div>
  );
}
