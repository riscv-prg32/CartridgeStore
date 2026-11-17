"use client";

/** Shared field renderer for the first-installation wizard. */
export function SetupField({
  label,
  name,
  type = "text",
  value,
  onChange,
  required = false,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  required?: boolean;
  help?: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-medium" htmlFor={name}>
      <span>{label}</span>
      {type === "checkbox" ? (
        <input
          id={name}
          name={name}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
          className="size-4 accent-violet-700"
        />
      ) : (
        <input
          id={name}
          name={name}
          type={type}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          className={[
            "rounded-lg border border-[var(--color-border)]",
            "bg-[var(--color-surface)] px-3 py-2 font-normal",
          ].join(" ")}
        />
      )}
      {help ? (
        <span className="text-xs font-normal text-[var(--color-text-muted)]">
          {help}
        </span>
      ) : null}
    </label>
  );
}
