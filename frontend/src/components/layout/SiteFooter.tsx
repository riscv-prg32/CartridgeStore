import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="page-gutter py-7 sm:py-8">
        <div className="grid grid-cols-1 gap-8 border-b border-[var(--color-border)] pb-6 md:grid-cols-[minmax(0,2fr)_minmax(9rem,1fr)_minmax(9rem,1fr)] md:gap-8 lg:gap-10">
          <div>
            <p className="technical-label text-[var(--color-primary-strong)]">PRG32</p>
            <p className="mt-3 max-w-prose text-sm font-semibold leading-6 text-[var(--color-text)]">An open-source educational RISC-V platform for learning assembly and C.</p>
            <p className="mt-2 max-w-prose text-sm leading-6 text-[var(--color-text-muted)]">A project of the University of Naples Parthenope.</p>
            <p className="mt-2 max-w-prose text-sm leading-6 text-[var(--color-text-muted)]">Cartridge Store is part of the PRG32 project ecosystem.</p>
          </div>

          <nav aria-label="Explore footer links">
            <h2 className="technical-label text-[var(--color-text-muted)]">EXPLORE</h2>
            <div className="mt-3 flex flex-col items-start gap-2">
              <Link className="rounded-sm py-1 text-sm font-semibold text-[var(--color-text)] underline-offset-4 hover:text-[var(--color-primary-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="/explore">Explore</Link>
              <Link className="rounded-sm py-1 text-sm font-semibold text-[var(--color-text)] underline-offset-4 hover:text-[var(--color-primary-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="/scores">Leaderboards</Link>
              <Link className="rounded-sm py-1 text-sm font-semibold text-[var(--color-text)] underline-offset-4 hover:text-[var(--color-primary-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="/stats">Statistics</Link>
            </div>
          </nav>

          <nav aria-label="Project footer links">
            <h2 className="technical-label text-[var(--color-text-muted)]">PROJECT</h2>
            <div className="mt-3 flex flex-col items-start gap-2">
              <a className="inline-flex rounded-sm py-1 text-sm font-semibold text-[var(--color-text)] underline-offset-4 hover:text-[var(--color-primary-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="https://github.com/riscv-prg32/PRG32" target="_blank" rel="noopener noreferrer">
                <span>GitHub</span>
                <span aria-hidden="true" className="ml-1.5">↗</span>
              </a>
              <Link className="rounded-sm py-1 text-sm font-semibold text-[var(--color-text)] underline-offset-4 hover:text-[var(--color-primary-strong)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-[var(--color-ring)]" href="/docs">Documentation</Link>
            </div>
          </nav>
        </div>
        <div className="flex flex-col gap-2 pt-4 text-xs text-[var(--color-text-muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>Università degli Studi di Napoli Parthenope</p>
          <p>Open source · MIT License</p>
        </div>
      </div>
    </footer>
  );
}
