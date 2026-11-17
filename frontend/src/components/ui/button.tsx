import type { ButtonHTMLAttributes } from "react";
import { LoaderCircle } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "../../lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger" | "icon";
  size?: "sm" | "default" | "lg" | "icon";
  loading?: boolean;
  asChild?: boolean;
};

export function Button({ className, variant = "primary", size = "default", loading = false, disabled, asChild = false, children, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "min-h-9 px-3 py-1.5 text-xs",
        size === "default" && "min-h-10 px-4 py-2",
        size === "lg" && "min-h-11 px-5 py-2.5",
        (size === "icon" || variant === "icon") && "size-10 p-0",
        variant === "primary" && "bg-[var(--color-primary)] text-[var(--color-primary-foreground)] shadow-sm hover:bg-[var(--color-primary-strong)]",
        variant === "secondary" && "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]",
        variant === "outline" && "border border-[var(--color-primary)] bg-transparent text-[var(--color-primary-strong)] hover:bg-[var(--color-primary-soft)]",
        variant === "ghost" && "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]",
        variant === "danger" && "bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger-foreground)]",
        variant === "icon" && "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]",
        className,
      )}
      {...props}
    >
      {asChild ? children : <>{loading && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}{children}</>}
    </Component>
  );
}
