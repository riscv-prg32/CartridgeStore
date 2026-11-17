"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AuthNavigation } from "../auth/AuthNavigation";
import { BrandLogo } from "./BrandLogo";
import { SiteFooter } from "./SiteFooter";
import { ThemeToggle } from "./ThemeToggle";
import { BootSplash } from "./BootSplash";
import { RuntimeFavicon } from "./RuntimeFavicon";
import { navigationIsActive, PUBLIC_NAVIGATION } from "./navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { useLocale } from "../../providers/LocaleProvider";

function publicNavigationLabel(href: string, t: ReturnType<typeof useLocale>["t"]) {
  if (href === "/explore") return t("explore");
  if (href === "/scores") return t("leaderboards");
  if (href === "/stats") return t("statistics");
  if (href === "/firmware") return "Firmware";
  return t("documentation");
}

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = usePathname();
  const { t } = useLocale();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <BootSplash />
      <RuntimeFavicon />
      <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 shadow-[var(--shadow-header)] backdrop-blur">
        <div className="page-gutter flex min-h-16 items-center justify-between gap-4 py-3">
          <Link
            aria-label="PRG32 Cartridge Store"
            className="flex min-w-0 items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-ring)]"
            href="/"
            onClick={() => setMobileOpen(false)}
          >
            <BrandLogo />
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <nav aria-label="Primary navigation" className="hidden items-center gap-1 md:flex">
              {PUBLIC_NAVIGATION.map((item) => {
                const active = navigationIsActive(pathname, item.href);
                return <Link key={item.href} aria-current={active ? "page" : undefined} className={`rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)] ${active ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"}`} href={item.href}>{publicNavigationLabel(item.href, t)}</Link>;
              })}
            </nav>
            <ThemeToggle />
            <AuthNavigation />
            <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
              <DialogTrigger asChild>
                <button type="button" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} className="grid size-10 place-items-center rounded-lg border border-[var(--color-border)] text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)] md:hidden">
                  <span aria-hidden="true" className="text-lg leading-none">{mobileOpen ? "×" : "☰"}</span>
                </button>
              </DialogTrigger>
              <DialogContent aria-describedby="mobile-navigation-description" className="inset-x-0 top-16 max-h-[calc(100vh-4rem)] translate-y-0 rounded-none border-x-0 border-t-0 p-0 md:hidden">
                <DialogHeader className="border-b border-[var(--color-border)] px-5 py-4 pr-14">
                  <DialogTitle>Navigate the Store</DialogTitle>
                  <DialogDescription id="mobile-navigation-description">Explore published cartridges, public telemetry, and documentation.</DialogDescription>
                </DialogHeader>
                <nav aria-label="Mobile primary navigation" className="page-gutter grid gap-1 py-3">
                  {PUBLIC_NAVIGATION.map((item) => {
                    const active = navigationIsActive(pathname, item.href);
                    return <Link key={item.href} aria-current={active ? "page" : undefined} className={`rounded-md px-3 py-3 text-sm font-semibold ${active ? "bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"}`} href={item.href} onClick={() => setMobileOpen(false)}>{publicNavigationLabel(item.href, t)}</Link>;
                  })}
                </nav>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
      {!pathname.startsWith("/dashboard") && <SiteFooter />}
    </div>
  );
}
