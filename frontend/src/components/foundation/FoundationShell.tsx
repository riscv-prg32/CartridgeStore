"use client";

import { Button } from "../ui/button";
import { useThemeStore } from "../../stores/theme-store";

export function FoundationShell() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-6 px-6 py-12">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">Migration foundation</p>
        <h1 className="text-4xl font-bold tracking-tight">PRG32 Cartridge Store</h1>
        <p className="max-w-2xl text-lg text-[var(--color-text-muted)]">
          Next.js and TypeScript are ready for the incremental migration. Storefront features remain intentionally out of scope for this milestone.
        </p>
      </div>
      <Button
        className="w-fit"
        variant="secondary"
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      >
        Use {theme === "light" ? "dark" : "light"} theme
      </Button>
    </main>
  );
}
