"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCurrentUser } from "../../lib/auth/use-current-user";
import { accountNavigation, CONTEXTUAL_NAVIGATION, filterNavigation, navigationIsActive, type NavigationItem } from "./navigation";

type Context = "account" | "creator" | "review";

const CONTEXT_COPY: Record<Context, { eyebrow: string; title: string; description: string }> = {
  account: {
    eyebrow: "Personal space",
    title: "Account",
    description: "Manage your profile, creator access, and store activity.",
  },
  creator: {
    eyebrow: "Creator workspace",
    title: "Studio",
    description: "Prepare, publish, and track your cartridge submissions.",
  },
  review: {
    eyebrow: "Moderation workspace",
    title: "Review",
    description: "Keep the publication queue moving with clear decisions.",
  },
};

function NavigationLink({ item, pathname }: { item: NavigationItem; pathname: string | null }) {
  const active = navigationIsActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`group rounded-md border px-3 py-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-ring)] ${
        active
          ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-text)]"
          : "border-transparent text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      <span className="block text-sm font-semibold">{item.label}</span>
      {item.description && <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">{item.description}</span>}
    </Link>
  );
}

export function ContextualNavigation({ context }: { context: Context }) {
  const pathname = usePathname();
  const current = useCurrentUser();
  const permissions = current.user?.permissions;
  const items = context === "account" ? accountNavigation(permissions) : filterNavigation(CONTEXTUAL_NAVIGATION[context], permissions);
  const copy = CONTEXT_COPY[context];

  return (
    <aside className="surface-card p-3 lg:sticky lg:top-6 lg:self-start">
      <div className="border-b border-[var(--color-border)] px-2 pb-3">
        <p className="technical-label text-[var(--color-primary)]">{copy.eyebrow}</p>
        <h2 className="mt-1 text-lg font-bold tracking-tight">{copy.title}</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{copy.description}</p>
      </div>
      <nav aria-label={`${copy.title} navigation`} className="grid gap-1 pt-3 sm:grid-cols-2 lg:grid-cols-1">
        {items.map((item) => <NavigationLink key={item.href} item={item} pathname={pathname} />)}
      </nav>
    </aside>
  );
}
