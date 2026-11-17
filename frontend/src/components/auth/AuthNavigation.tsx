"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  AlertTriangle,
  ClipboardCheck,
  CircleUserRound,
  ChevronDown,
  ExternalLink,
  Languages,
  LayoutDashboard,
  LogOut,
  Network,
  Rocket,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ApiRequestError } from "../../lib/api/client";
import { logoutLocal } from "../../lib/api/auth";
import { authQueryKeys } from "../../lib/api/query-keys";
import { removeSensitiveQueryData } from "../../lib/auth/query-cache";
import { authErrorMessage } from "../../lib/api/auth";
import { authIntegrationEnabled } from "../../lib/auth/config";
import { useCurrentUser } from "../../lib/auth/use-current-user";
import { useLocale } from "../../providers/LocaleProvider";
import { accountNavigation } from "../layout/navigation";
import { Button } from "../ui/button";
import { StatusMessage } from "../ui/status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

function contextualLabel(href: string, t: ReturnType<typeof useLocale>["t"], fallback: string) {
  if (href === "/workspace") return t("creatorStudio");
  if (href === "/review") return t("reviewQueue");
  if (href === "/admin") return t("administration");
  return fallback;
}

export function AuthNavigation() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const current = useCurrentUser();
  const { locale, setLocale, t } = useLocale();
  const logout = useMutation({
    mutationFn: logoutLocal,
    onSuccess: () => {
      removeSensitiveQueryData(queryClient);
      queryClient.setQueryData(authQueryKeys.currentUser(), null);
      router.replace("/login");
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 401) {
        removeSensitiveQueryData(queryClient);
        queryClient.setQueryData(authQueryKeys.currentUser(), null);
        router.replace("/login?reason=expired");
      }
    },
  });

  if (!authIntegrationEnabled) return null;
  if (current.isPending) {
    return (
      <span
        aria-label="Loading account"
        className="inline-flex items-center"
        role="status"
      >
        <span
          aria-hidden="true"
          className="size-8 animate-pulse rounded-full bg-[var(--color-surface-muted)]"
        />
        <span className="sr-only">{t("loadingAccount")}…</span>
      </span>
    );
  }
  if (current.error) {
    const message = authErrorMessage(current.error, "session");
    return <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300" role="alert" title={message}><AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" /><span aria-hidden="true" className="hidden sm:inline">{t("authUnavailable")}</span><span className="sr-only">{message}. </span><Link aria-label={t("retryAuthentication")} className="shrink-0 font-semibold underline underline-offset-2" href="/login">{t("retry")}</Link></span>;
  }
  if (!current.user) return <Button asChild size="sm" className="px-3"><Link href="/login">{t("signIn")}</Link></Button>;

  const displayName = current.user.name?.trim() || current.user.username;
  const contextualLinks = accountNavigation(current.user.permissions).filter((item) => item.href !== "/dashboard/account");
  const contextualIcons: Record<string, LucideIcon> = {
    "/workspace": Rocket,
    "/review": ClipboardCheck,
    "/admin": ShieldCheck,
    "/admin/federation": Network,
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="max-w-48 gap-2 px-1.5 sm:px-2" aria-label={`${t("openAccountMenu")} ${displayName}`}>
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary-strong)]">
              <UserRound aria-hidden="true" className="size-4" />
            </span>
            <span className="hidden truncate sm:inline">{displayName}</span>
            <ChevronDown aria-hidden="true" className="hidden size-3.5 text-[var(--color-text-muted)] sm:inline" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={10}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-2xl p-2"
        >
          <div className="flex items-center gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--color-primary)] text-base font-bold text-white shadow-[var(--shadow-brand)]">
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="break-all text-[11px] leading-4 text-[var(--color-text-muted)]">{current.user.email}</p>
            </div>
          </div>

          <DropdownMenuLabel className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-[0.16em]">
            {t("account")}
          </DropdownMenuLabel>
          <DropdownMenuItem asChild className="gap-3 px-3 py-2.5">
            <Link href="/dashboard/account">
              <CircleUserRound aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
              <span>{t("yourAccount")}</span>
            </Link>
          </DropdownMenuItem>

          <DropdownMenuLabel className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-[0.16em]">
            {t("workspace")}
          </DropdownMenuLabel>
          <DropdownMenuItem asChild className="gap-3 px-3 py-2.5">
            <Link href="/dashboard">
              <LayoutDashboard aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
              <span>{t("developerDashboard")}</span>
            </Link>
          </DropdownMenuItem>
          {contextualLinks.map((item) => {
            const Icon = contextualIcons[item.href] ?? ArrowUpRight;
            return (
              <DropdownMenuItem key={item.href} asChild className="gap-3 px-3 py-2.5">
                <Link href={item.href}>
                  <Icon aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
                  <span>{contextualLabel(item.href, t, item.label)}</span>
                </Link>
              </DropdownMenuItem>
            );
          })}
          {current.user.permissions?.includes("federation:read") && (
            <DropdownMenuItem asChild className="gap-3 px-3 py-2.5">
              <Link href="/admin/federation">
                <Network aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
                <span>{t("federation")}</span>
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="px-3 pb-1 pt-3 text-[10px] uppercase tracking-[0.16em]">
            {t("language")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={locale} onValueChange={(value) => {
            if (value === "en" || value === "it") setLocale(value);
          }}>
            <DropdownMenuRadioItem value="en" className="gap-3 py-2.5 pr-3 pl-9">
              <Languages aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
              <span>{t("english")}</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="it" className="gap-3 py-2.5 pr-3 pl-9">
              <Languages aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
              <span>{t("italian")}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-3 px-3 py-2.5">
            <Link href={`/users/${encodeURIComponent(current.user.username)}`}>
              <ExternalLink aria-hidden="true" className="size-4 text-[var(--color-text-muted)]" />
              <span>{t("publicProfile")}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => logout.mutate()}
            className="gap-3 px-3 py-2.5 text-rose-700 data-[highlighted]:bg-rose-50 data-[highlighted]:text-rose-800 dark:text-rose-300 dark:data-[highlighted]:bg-rose-950/40 dark:data-[highlighted]:text-rose-200"
          >
            <LogOut aria-hidden="true" className="size-4" />
            <span>{t("signOut")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {logout.isPending && <span className="sr-only" role="status">{t("signingOut")}</span>}
      {logout.error && <StatusMessage tone="danger" className="px-2 py-1">{authErrorMessage(logout.error, "logout")}</StatusMessage>}
    </div>
  );
}
