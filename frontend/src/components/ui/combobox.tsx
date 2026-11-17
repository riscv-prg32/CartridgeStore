"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type ComboboxOption = {
  value: string;
  label: string;
};

export function ComboboxField({
  label,
  value,
  onValueChange,
  options,
  placeholder = "Search…",
  name,
  icon,
}: {
  label: string;
  value: string;
  onValueChange?: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  name?: string;
  icon?: ReactNode;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedValue, setSelectedValue] = useState(value);

  const selectedLabel = options.find((option) => option.value === selectedValue)?.label ?? selectedValue;
  const filteredOptions = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes(normalized));
  }, [options, search]);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  function openMenu() {
    setOpen(true);
    setSearch("");
  }

  function choose(nextValue: string) {
    setSelectedValue(nextValue);
    onValueChange?.(nextValue);
    setSearch("");
    setOpen(false);
    inputRef.current?.blur();
  }

  return (
    <div ref={rootRef} className="grid gap-2">
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {label}
      </label>
      <div className="relative">
        <div className="flex min-h-11 w-full items-center overflow-hidden rounded-lg border border-[var(--color-input)] bg-[var(--color-bg)]">
          <Search aria-hidden="true" className="ml-3 size-4 shrink-0 text-[var(--color-text-muted)]" />
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-label={label}
            aria-controls={`${id}-listbox`}
            aria-expanded={open}
            aria-haspopup="listbox"
            data-combobox-input
            autoComplete="off"
            className="min-w-0 flex-1 border-0 bg-transparent px-2 py-2 text-sm outline-none focus:outline-none focus-visible:outline-none placeholder:text-[var(--color-text-muted)]"
            placeholder={placeholder}
            value={open ? search : selectedLabel}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelectedValue(event.target.value);
              onValueChange?.(event.target.value);
              setOpen(true);
            }}
            onFocus={openMenu}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                inputRef.current?.blur();
              }
              if (event.key === "Enter" && filteredOptions[0]) {
                event.preventDefault();
                choose(filteredOptions[0].value);
              }
            }}
          />
          <button type="button" aria-label={`Open ${label} options`} data-combobox-toggle className="mr-1 grid size-9 place-items-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]" onClick={() => (open ? setOpen(false) : openMenu())}>
            <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </div>
        <input type="hidden" name={name} value={selectedValue} />
        {open && (
          <div id={`${id}-listbox`} role="listbox" aria-label={`${label} options`} className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-popover)]">
            <button type="button" role="option" aria-selected={selectedValue === ""} className="flex min-h-10 w-full appearance-none items-center gap-2 rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm hover:bg-[var(--color-primary-soft)]" onClick={() => choose("")}>
              <span className="size-4 shrink-0">{selectedValue === "" && <Check aria-hidden="true" className="size-4" />}</span>
              All games
            </button>
            {filteredOptions.length > 0 ? filteredOptions.map((option) => (
              <button key={option.value} type="button" role="option" aria-selected={selectedValue === option.value} className="flex min-h-10 w-full appearance-none items-center gap-2 rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm hover:bg-[var(--color-primary-soft)]" onClick={() => choose(option.value)}>
                <span className="size-4 shrink-0">{selectedValue === option.value && <Check aria-hidden="true" className="size-4" />}</span>
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            )) : <p className="px-3 py-3 text-sm text-[var(--color-text-muted)]">No matching games.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
