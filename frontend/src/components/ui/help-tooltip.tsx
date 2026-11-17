"use client";

import { useId } from "react";

export function HelpTooltip({ label, text }: { label: string; text: string }) {
  const id = useId();

  return (
    <span className="group relative inline-flex shrink-0 align-middle">
      <span
        aria-describedby={id}
        aria-label={`About ${label}`}
        className="grid size-4 cursor-help place-items-center rounded-full border border-[var(--color-text-muted)] text-[0.65rem] font-bold leading-none text-[var(--color-text-muted)] outline-none transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
        role="img"
        tabIndex={0}
        title={text}
      >
        ?
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute left-0 top-full z-50 mt-2 w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-text)] px-3 py-2 text-left text-xs font-normal leading-5 text-white opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
