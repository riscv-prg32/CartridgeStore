import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type BadgeVariant = "game" | "utility" | "success" | "warning" | "danger" | "published" | "version" | "architecture";

const variants: Record<BadgeVariant, string> = {
  game: "border-[var(--color-primary)]/50 bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]",
  utility: "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]",
  success: "border-[var(--color-success)]/50 bg-[var(--color-success-soft)] text-[var(--color-success-foreground)]",
  published: "rounded-sm border-transparent bg-transparent px-0 text-[var(--color-success-foreground)] before:mr-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:bg-[var(--color-success)] before:content-['']",
  warning: "border-[var(--color-warning)]/50 bg-[var(--color-warning-soft)] text-[var(--color-warning-foreground)]",
  danger: "border-[var(--color-danger)]/50 bg-[var(--color-danger-soft)] text-[var(--color-danger-foreground)]",
  version: "border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text)]",
  architecture: "border-[var(--color-border)] bg-transparent text-[var(--color-text-muted)]",
};

export function Badge({ className, variant = "utility", ...props }: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant }) {
  return <span className={cn("inline-flex min-h-6 items-center rounded-sm border px-2 py-0.5 text-xs font-semibold leading-5", variants[variant], className)} {...props} />;
}
