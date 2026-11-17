"use client";

import { Search, X } from "lucide-react";
import type { InputHTMLAttributes } from "react";

import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Input } from "./input";

export function SearchInput({ className, onClear, ...props }: InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void }) {
  return <div className={cn("relative flex min-w-0 items-center", className)}><Search aria-hidden="true" className="pointer-events-none absolute left-3 size-4 text-[var(--color-text-muted)]" /><Input className="min-h-11 pl-9 pr-10" {...props} />{onClear && props.value ? <Button type="button" variant="icon" size="icon" aria-label="Clear search" className="absolute right-1 size-8 border-0 bg-transparent" onClick={onClear}><X aria-hidden="true" className="size-4" /></Button> : null}</div>;
}
