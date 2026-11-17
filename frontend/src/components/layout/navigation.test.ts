import { describe, expect, it } from "vitest";

import { accountNavigation, navigationIsActive, PUBLIC_NAVIGATION } from "./navigation";

describe("navigation model", () => {
  it("keeps the public surface focused on discovery", () => {
    expect(PUBLIC_NAVIGATION.map((item) => item.label)).toEqual(["Explore", "Leaderboards", "Statistics", "Firmware", "Documentation"]);
    expect(PUBLIC_NAVIGATION.map((item) => item.href)).toEqual(["/explore", "/scores", "/stats", "/firmware", "/docs"]);
    expect(PUBLIC_NAVIGATION.map((item) => item.label)).not.toContain("Search");
    expect(PUBLIC_NAVIGATION.map((item) => item.href)).not.toContain("/admin");
  });

  it("exposes contextual destinations only for the principal capabilities", () => {
    expect(accountNavigation([]).map((item) => item.href)).toEqual(["/dashboard/account"]);
    expect(accountNavigation(["catalog:submit"]).map((item) => item.href)).toEqual(["/dashboard/account", "/workspace"]);
    expect(accountNavigation(["submissions:review"]).map((item) => item.href)).toEqual(["/dashboard/account", "/review"]);
    expect(accountNavigation(["users:read"]).map((item) => item.href)).toEqual(["/dashboard/account", "/admin"]);
    expect(accountNavigation(["catalog:metadata:write", "submissions:review"]).map((item) => item.href)).toEqual(["/dashboard/account", "/review"]);
  });

  it("matches nested routes without making the root active everywhere", () => {
    expect(navigationIsActive("/explore", "/explore")).toBe(true);
    expect(navigationIsActive("/games/demo", "/explore")).toBe(false);
    expect(navigationIsActive("/", "/explore#catalog-search")).toBe(false);
    expect(navigationIsActive("/docs/getting-started", "/docs")).toBe(true);
    expect(navigationIsActive("/docs", "/#catalog-search")).toBe(false);
  });
});
