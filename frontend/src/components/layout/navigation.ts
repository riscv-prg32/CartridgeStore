export type NavigationPermission = string;

export type NavigationItem = {
  label: string;
  href: string;
  description?: string;
  permission?: NavigationPermission;
};

export const PUBLIC_NAVIGATION: NavigationItem[] = [
  { label: "Explore", href: "/explore" },
  { label: "Leaderboards", href: "/scores" },
  { label: "Statistics", href: "/stats" },
  { label: "Firmware", href: "/firmware" },
  { label: "Documentation", href: "/docs" },
];

export const ADMIN_PERMISSIONS = [
  "settings:read",
  "users:read",
  "groups:read",
  "roles:read",
  "tokens:read:any",
  "backup:export",
  "federation:read",
] as const;

export function hasPermission(permissions: readonly string[] | undefined, permission: string): boolean {
  return Boolean(permissions?.includes(permission));
}

export function hasAnyPermission(permissions: readonly string[] | undefined, required: readonly string[]): boolean {
  return required.some((permission) => hasPermission(permissions, permission));
}

export function accountNavigation(permissions?: readonly string[]): NavigationItem[] {
  const items: NavigationItem[] = [
    { label: "Your account", href: "/dashboard/account", description: "Profile and security" },
  ];

  if (hasPermission(permissions, "catalog:submit")) {
    items.push({ label: "Creator Studio", href: "/workspace", description: "Prepare and publish cartridges" });
  }
  if (hasAnyPermission(permissions, ["submissions:read", "submissions:review", "submissions:reject"])) {
    items.push({ label: "Review queue", href: "/review", description: "Review submitted cartridges" });
  }
  if (hasAnyPermission(permissions, ADMIN_PERMISSIONS)) {
    items.push({ label: "Administration", href: "/admin", description: "Manage the store" });
  }

  return items;
}

export const CONTEXTUAL_NAVIGATION: Record<"account" | "creator" | "review", NavigationItem[]> = {
  account: accountNavigation(),
  creator: [
    { label: "Studio overview", href: "/workspace" },
    { label: "Publish cartridge", href: "/publish" },
    { label: "Your account", href: "/dashboard/account" },
  ],
  review: [
    { label: "Review queue", href: "/review" },
    { label: "Creator Studio", href: "/workspace", permission: "catalog:submit" },
    { label: "Your account", href: "/dashboard/account" },
  ],
};

export function filterNavigation(items: readonly NavigationItem[], permissions?: readonly string[]): NavigationItem[] {
  return items.filter((item) => !item.permission || hasPermission(permissions, item.permission));
}

export function navigationIsActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href.includes("#")) return false;
  const path = href.split("#", 1)[0] || "/";
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}
