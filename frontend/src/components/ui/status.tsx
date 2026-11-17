import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "../../lib/cn";

export type StatusTone = "muted" | "info" | "success" | "warning" | "danger";

const toneClasses: Record<StatusTone, string> = {
  muted: "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)]",
  info: "border-[var(--color-primary)]/50 bg-[var(--color-primary-soft)] text-[var(--color-text)]",
  success: "border-[var(--color-success)]/50 bg-[var(--color-success-soft)] text-[var(--color-success-foreground)]",
  warning: "border-[var(--color-warning)]/50 bg-[var(--color-warning-soft)] text-[var(--color-warning-foreground)]",
  danger: "border-[var(--color-danger)]/50 bg-[var(--color-danger-soft)] text-[var(--color-danger-foreground)]",
};

export function StatusMessage({
  children,
  tone = "muted",
  role,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; tone?: StatusTone }) {
  const defaultRole = tone === "danger" ? "alert" : tone === "success" || tone === "warning" ? "status" : undefined;
  return (
    <div
      role={role ?? defaultRole}
      className={cn("rounded-md border px-4 py-3 text-sm", toneClasses[tone], className)}
      {...props}
    >
      {children}
    </div>
  );
}
