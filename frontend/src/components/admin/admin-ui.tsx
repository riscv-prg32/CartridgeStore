import type { InputHTMLAttributes, ReactNode } from "react";

import { AdminIntegrationUnavailableError } from "../../lib/api/admin";
import { ApiRequestError } from "../../lib/api/client";
import { cn } from "../../lib/cn";
import { HelpTooltip } from "../ui/help-tooltip";
import { StatusMessage } from "../ui/status";

export function errorMessage(error: unknown): string {
  if (error instanceof AdminIntegrationUnavailableError) return "Fastify admin isolato non configurato in questo ambiente.";
  if (error instanceof ApiRequestError) return error.body?.error ?? "Operazione amministrativa rifiutata.";
  if (error instanceof Error) return error.message;
  return "Operazione amministrativa non riuscita.";
}

export function Notice({ error, success }: { error?: unknown; success?: string }) {
  if (error) return <StatusMessage tone="danger" className="px-3 py-2">{errorMessage(error)}</StatusMessage>;
  if (success) return <StatusMessage tone="success" className="px-3 py-2">{success}</StatusMessage>;
  return null;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="w-full max-w-full min-w-0 space-y-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-sm"><div><h2 className="text-xl font-semibold">{title}</h2></div>{children}</section>;
}

export function Field({ label, help, id, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string }) {
  return (
    <label className="grid gap-1 text-sm font-medium" htmlFor={id}>
      <span className="flex items-center gap-1.5">
        {label}
        {help ? <HelpTooltip label={label} text={help} /> : null}
      </span>
      <input
        {...props}
        id={id}
        className={cn(
          "min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-normal text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]",
          className,
        )}
      />
    </label>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <div className="overflow-x-auto rounded-md border border-[var(--color-border)]"><table className="w-full border-collapse text-left text-sm">{children}</table></div>;
}
