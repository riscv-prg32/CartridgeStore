import { ExternalLink, FileCode2, Gamepad2 } from "lucide-react";

import type { Game } from "../../lib/api/contracts";
import { Card, CardContent, CardHeader } from "../ui/card";

type ColophonValue = Record<string, unknown>;

function recordValue(value: unknown): ColophonValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ColophonValue
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function controlEntries(colophon: ColophonValue | null): Array<{
  action: string;
  input: string;
}> {
  if (!colophon || !Array.isArray(colophon.controls)) return [];

  return colophon.controls.flatMap((value) => {
    const control = recordValue(value);
    const action = stringValue(control?.action);
    const input = stringValue(control?.input);
    return action && input ? [{ action, input }] : [];
  });
}

/** Renders the playable controls published in a cartridge colophon. */
export function ColophonControls({ colophon, compact = false }: { colophon: Game["colophon"]; compact?: boolean }) {
  const value = recordValue(colophon);
  const controls = controlEntries(value);
  const subtitle = stringValue(value?.subtitle);
  const developer = stringValue(recordValue(value?.developer)?.name);

  if (controls.length === 0 && !subtitle && !developer) return null;

  return (
    <section className={compact ? "" : "mt-6 border-t border-[var(--color-border)] pt-5"}>
      <div className="flex items-start gap-3">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-lg
            bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]"
        >
          <Gamepad2 aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="technical-label text-[var(--color-primary)]">Colophon</p>
          <h3 className="mt-1 font-bold">Controls</h3>
          {subtitle && (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {controls.length > 0 && (
        <dl className="mt-4 overflow-hidden rounded-lg border border-[var(--color-border)]">
          {controls.map((control) => (
            <div
              key={`${control.input}-${control.action}`}
              className="flex flex-wrap items-center gap-3 border-b
                border-[var(--color-border)] px-3 py-3 last:border-b-0 sm:px-4"
            >
              <dt>
                <kbd
                  className="inline-flex min-w-16 justify-center rounded-md border
                    border-[var(--color-primary)]/30 bg-[var(--color-primary-soft)]
                    px-2.5 py-1.5 text-xs font-bold text-[var(--color-primary-strong)]"
                >
                  {control.input}
                </kbd>
              </dt>
              <dd className="text-sm font-semibold text-[var(--color-text)]">
                {control.action}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {developer && (
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Developed by <span className="font-semibold">{developer}</span>
        </p>
      )}
    </section>
  );
}

function metadataLabel(key: string): string {
  const labels: Record<string, string> = {
    abi: "Metadata ABI",
    id: "Cartridge ID",
    license: "License",
    repository: "Repository",
    homepage: "Homepage",
    description: "Description",
  };
  return labels[key] ?? key.replaceAll("_", " ");
}

function metadataEntries(metadata: Record<string, unknown> | null) {
  if (!metadata) return [];
  const duplicateFields = new Set(["title", "summary", "version"]);

  return Object.entries(metadata).filter(
    ([key, value]) =>
      !duplicateFields.has(key) &&
      key !== "description" &&
      ["string", "number", "boolean"].includes(typeof value),
  );
}

function MetadataValue({ value }: { value: string }) {
  if (/^https?:\/\//u.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden
          text-[var(--color-primary-strong)] hover:underline"
        title={value}
      >
        <span className="truncate">{value}</span>
        <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
    );
  }

  return <span className="break-words">{value}</span>;
}

/** Renders the non-duplicated technical fields published in cartridge metadata. */
export function TechnicalMetadata({
  metadata,
  className,
}: {
  metadata: Game["metadata"];
  className?: string;
}) {
  const entries = metadataEntries(metadata);

  return (
    <Card className={className ? `mt-6 ${className}` : "mt-6"}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-lg
              bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]"
          >
            <FileCode2 aria-hidden="true" className="size-4" />
          </span>
          <div>
            <h2 className="font-bold">Technical metadata</h2>
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Published cartridge identity and implementation details.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {entries.length > 0 ? (
          <dl className="grid gap-2 sm:grid-cols-2">
            {entries.map(([key, value]) => (
              <div
                key={key}
                className="min-w-0 rounded-lg border border-[var(--color-border)]
                  bg-[var(--color-surface-muted)] px-3 py-3 sm:px-4"
              >
                <dt
                  className="text-[11px] font-semibold uppercase tracking-wide
                    text-[var(--color-text-muted)]"
                >
                  {metadataLabel(key)}
                </dt>
                <dd className="mt-1 text-sm text-[var(--color-text)]">
                  <MetadataValue value={String(value)} />
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            No additional technical metadata was published.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
