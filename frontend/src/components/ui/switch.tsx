import type { ChangeEvent } from "react";

import { HelpTooltip } from "./help-tooltip";

type SwitchProps = {
  checked: boolean;
  label: string;
  description?: string;
  help?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

/** Renders an accessible controlled switch for boolean settings. */
export function Switch({
  checked,
  label,
  description,
  help,
  disabled = false,
  onChange,
}: SwitchProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.checked);
  }

  return (
    <label className="flex items-center justify-between gap-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-semibold">{label}{help ? <HelpTooltip label={label} text={help} /> : null}</span>
        {description ? (
          <span className="mt-1 block text-xs leading-5 text-[var(--color-text-muted)]">
            {description}
          </span>
        ) : null}
      </span>
      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={handleChange}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-[var(--color-border)] transition-colors peer-checked:bg-[var(--color-primary)] peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-ring)]"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 peer-disabled:bg-[var(--color-surface-muted)]"
        />
      </span>
    </label>
  );
}
