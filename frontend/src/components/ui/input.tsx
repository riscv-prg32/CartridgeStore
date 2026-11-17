import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const fieldClassName = "min-h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-colors placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-ring)] focus:ring-2 focus:ring-[var(--color-primary-soft)] disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-[var(--color-danger)]";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("min-h-24", fieldClassName, className)} {...props} />;
}

export function Field({ label, help, error, id, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string; error?: string }) {
  const generatedId = useId();
  const fieldId = id ?? props.name ?? `field-${generatedId.replaceAll(":", "")}`;
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("grid gap-1.5 text-sm font-semibold", className)}>
      <label htmlFor={fieldId}>{label}</label>
      <Input {...props} id={fieldId} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={describedBy ?? props["aria-describedby"]} aria-errormessage={error ? errorId : props["aria-errormessage"]} />
      {help && !error && <span id={helpId} className="text-xs font-normal text-[var(--color-text-muted)]">{help}</span>}
      {error && <span id={errorId} className="text-xs font-normal text-[var(--color-danger-foreground)]">{error}</span>}
    </div>
  );
}
