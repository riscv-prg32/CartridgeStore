"use client";

import { Button } from "../components/ui/button";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">PRG32 Cartridge Store</p>
      <h1 className="text-3xl font-bold text-[var(--color-text)]">Something went wrong</h1>
      <p className="text-[var(--color-text-muted)]">The application boundary caught an unexpected error.</p>
      <Button className="w-fit" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
