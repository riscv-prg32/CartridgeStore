import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "../../lib/cn";
import { Badge } from "./badge";
import { Button } from "./button";

export function FilterGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <fieldset className={cn("grid gap-2", className)}><legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</legend>{children}</fieldset>;
}

export function ActiveFilter({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <Badge variant="utility" className="gap-1 pr-1">{label}<Button type="button" variant="icon" size="icon" aria-label={`Remove ${label} filter`} className="size-5 rounded-sm border-0 bg-transparent p-0" onClick={onRemove}><X aria-hidden="true" className="size-3.5" /></Button></Badge>;
}

export function FilterBar({ children, onClear, hasFilters = false, className }: { children: ReactNode; onClear?: () => void; hasFilters?: boolean; className?: string }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}{hasFilters && onClear && <Button type="button" variant="ghost" size="sm" onClick={onClear}>Clear filters</Button>}</div>;
}
