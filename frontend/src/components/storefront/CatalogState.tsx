import { PackageOpen, SearchX, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";

export function CatalogLoading() {
  return (
    <div className="card-grid" aria-busy="true" aria-label="Loading cartridges">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="h-64 animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
      ))}
    </div>
  );
}

export function CatalogEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex items-start gap-3 border-y border-dashed border-[var(--color-border)] px-1 py-8">
      {filtered ? <SearchX aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--color-primary)]" /> : <PackageOpen aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--color-primary)]" />}
      <div>
        <p className="font-semibold">{filtered ? "No cartridges match this search." : "The catalog is empty."}</p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        {filtered ? "Try a different title, author, tag, or game identifier." : "Published cartridges will appear here when they are available."}
      </p>
      </div>
    </div>
  );
}

export function CatalogError({ onRetry }: { onRetry: () => void }) {
  return (
    <StatusMessage tone="danger" className="flex flex-wrap items-center gap-3 rounded-none border-x-0 border-y px-1 py-4">
      <TriangleAlert aria-hidden="true" className="size-5 shrink-0" />
      <div className="min-w-0 flex-1"><p className="font-semibold">The catalog could not be loaded.</p><p className="mt-1 text-sm">The Store API may be unavailable. Try again in a moment.</p></div>
      <Button type="button" variant="secondary" size="sm" onClick={onRetry}>Try again</Button>
    </StatusMessage>
  );
}

export function DetailMissing() {
  return (
    <div className="mx-auto max-w-3xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-10 text-center">
      <p className="text-lg font-semibold">Cartridge not found</p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">This cartridge may be unpublished or no longer available.</p>
      <Button asChild className="mt-5" size="default"><Link href="/">Back to the catalog</Link></Button>
    </div>
  );
}
