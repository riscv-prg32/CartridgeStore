"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/cn";
import { HelpTooltip } from "./help-tooltip";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export function SelectTrigger({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger className={cn("inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-[var(--color-input)] bg-[var(--color-bg)] px-3 py-2 text-left text-sm text-[var(--color-text)] outline-none transition-colors hover:bg-[var(--color-surface-muted)] focus:border-[var(--color-ring)] focus:ring-2 focus:ring-[var(--color-primary-soft)] disabled:cursor-not-allowed disabled:opacity-60", className)} {...props}>{children}<SelectPrimitive.Icon><ChevronDown aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" /></SelectPrimitive.Icon></SelectPrimitive.Trigger>;
}

export function SelectContent({ className, children, position = "popper", ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  return <SelectPrimitive.Portal><SelectPrimitive.Content position={position} className={cn("z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-[var(--color-text)] shadow-[var(--shadow-popover)] outline-none", className)} {...props}><SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUp aria-hidden="true" className="size-4" /></SelectPrimitive.ScrollUpButton><SelectPrimitive.Viewport className="p-0.5">{children}</SelectPrimitive.Viewport><SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDown aria-hidden="true" className="size-4" /></SelectPrimitive.ScrollDownButton></SelectPrimitive.Content></SelectPrimitive.Portal>;
}

export function SelectItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item className={cn("relative flex min-h-9 cursor-default select-none items-center rounded-md py-1.5 pl-8 pr-3 text-sm outline-none transition-colors focus:outline-none focus:ring-0 focus-visible:!outline-none focus-visible:ring-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-primary-soft)] data-[highlighted]:text-[var(--color-text)]", className)} {...props}><span className="absolute left-2 flex size-4 items-center justify-center"><SelectPrimitive.ItemIndicator><Check aria-hidden="true" className="size-4" /></SelectPrimitive.ItemIndicator></span><SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText></SelectPrimitive.Item>;
}

export function SelectSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("my-1 h-px bg-[var(--color-border)]", className)} {...props} />;
}

export function SelectField({ label, value, onValueChange, children, placeholder, name, description, help, disabled, icon, compact = false }: { label: string; value: string; onValueChange: (value: string) => void; children: ReactNode; placeholder?: string; name?: string; description?: string; help?: string; disabled?: boolean; icon?: ReactNode; compact?: boolean }) {
  const id = name ? `select-${name}` : undefined;
  return <div className={compact ? "grid" : "grid gap-2"}>{!compact && <label htmlFor={id} className="flex items-center gap-2 text-sm font-semibold">{icon}{label}{help ? <HelpTooltip label={label} text={help} /> : null}</label>}<Select name={name} value={value} onValueChange={onValueChange} disabled={disabled}><SelectTrigger id={id} aria-label={label} className={compact ? "min-h-9 min-w-0 px-2.5 py-1.5 text-xs" : undefined}><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{children}</SelectContent></Select>{description && <p className="text-xs text-[var(--color-text-muted)]">{description}</p>}</div>;
}
