import { expect, test } from "@playwright/test";

const syntheticGame = (overrides = {}) => ({
  id: "org.example.ui91",
  title: "UI.9.1 Demo",
  summary: "A synthetic read-only acceptance cartridge.",
  authors: [{ name: "PRG32 Acceptance" }],
  tags: ["acceptance"],
  latest_version: "1.0.0",
  selected_version: "1.0.0",
  versions: ["1.0.0", "0.9.0"],
  architectures: ["qemu", "esp32c6"],
  metadata: { abi: "prg32-metadata-1.0" },
  colophon: null,
  variants: { qemu: { size: 1024, has_screenshot: false }, esp32c6: { size: 2048, has_screenshot: false } },
  publisher: "PRG32 Acceptance",
  updated_at: "2026-10-16T00:00:00Z",
  ...overrides,
});

const pagination = (page = 1, total = 2) => ({
  page,
  per_page: 100,
  total,
  pages: page === 1 ? 2 : 2,
  has_next: page === 1,
  has_prev: page > 1,
  next_page: page === 1 ? 2 : null,
  prev_page: page > 1 ? 1 : null,
});

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function selectTheme(page, theme) {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current !== theme) {
    await page.getByRole("button", { name: `Switch to ${theme} theme` }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test.describe("public route acceptance", () => {
  test("covers primary public routes at every required viewport and theme", async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const routes = [
      ["/", /Build cartridges/],
      ["/explore", /Browse the cartridge shelf/],
      ["/login", /Sign in|Authentication is disabled/],
      ["/register", /Create an account|Registration unavailable/],
      ["/register/complete", /Complete registration|Registration unavailable/],
      ["/forgot-password", /Forgot password/],
      ["/password-reset", /Reset password/],
      ["/docs", /Build for PRG32/],
      ["/docs/getting-started", /Getting started/],
      ["/scores", /Scoreboard/],
      ["/stats", /Statistics/],
    ];
    const viewports = [375, 768, 1024, 1440, 1920];

    for (const width of viewports) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.goto("/");
        await selectTheme(page, theme);
        for (const [path, heading] of routes) {
          const response = await page.goto(path);
          expect(response?.status() ?? 0, `${path} response`).toBeLessThan(500);
          await expect(page.getByRole("heading", { name: heading })).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
          expect(noHorizontalOverflow, `${path} at ${width}px/${theme}`).toBe(true);
        }
      }
    }

    expect(pageErrors).toEqual([]);
  });

  test("keeps desktop and mobile navigation keyboard-accessible", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/stats");
    const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(primaryNavigation).toBeVisible();
    await expect(primaryNavigation.getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    await expect(primaryNavigation.getByRole("link", { name: "Leaderboards" })).toHaveAttribute("href", "/scores");
    await expect(primaryNavigation.getByRole("link", { name: "Statistics" })).toHaveAttribute("aria-current", "page");
    await expect(primaryNavigation.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs");
    await expect(primaryNavigation.getByRole("link", { name: "Search" })).toHaveCount(0);
    await primaryNavigation.getByRole("link", { name: "Statistics" }).focus();
    await expect(primaryNavigation.getByRole("link", { name: "Statistics" })).toBeFocused();

    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");
    const menu = page.getByRole("button", { name: "Open navigation" });
    await menu.click();
    const mobileNavigation = page.getByRole("navigation", { name: "Mobile primary navigation" });
    await expect(mobileNavigation).toBeVisible();
    await expect(mobileNavigation.getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    await expect(mobileNavigation.getByRole("link", { name: "Leaderboards" })).toHaveAttribute("href", "/scores");
    await expect(mobileNavigation.getByRole("link", { name: "Statistics" })).toHaveAttribute("href", "/stats");
    await expect(mobileNavigation.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs");
    await expect(mobileNavigation.getByRole("link", { name: "Search" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();

    await page.getByRole("button", { name: "Open navigation" }).click();
    await mobileNavigation.getByRole("link", { name: "Explore" }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.getByRole("navigation", { name: "Mobile primary navigation" })).toHaveCount(0);

    await page.goto("/forgot-password");
    const identifier = page.getByLabel("Email or username");
    await expect(identifier).toHaveAttribute("autocomplete", "username");
    await identifier.focus();
    await expect(identifier).toBeFocused();
  });

  test("renders one responsive institutional footer across both themes", async ({ page }) => {
    test.setTimeout(120_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const footerRoutes = ["/", "/explore", "/docs", "/docs/getting-started", "/stats", "/login"];
    const viewports = [375, 768, 1024, 1440, 1920];

    for (const width of viewports) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.goto("/");
        await selectTheme(page, theme);
        await expect(page.getByRole("heading", { name: /Build cartridges/ })).toBeVisible();
        const footer = page.getByRole("contentinfo");
        await expect(footer).toHaveCount(1);
        await expect(footer).toContainText("Università degli Studi di Napoli Parthenope");
        await expect(footer.getByRole("heading", { name: "EXPLORE" })).toBeVisible();
        await expect(footer.getByRole("heading", { name: "PROJECT" })).toBeVisible();
        const exploreLinks = footer.getByRole("navigation", { name: "Explore footer links" });
        await expect(exploreLinks.getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
        await expect(exploreLinks.getByRole("link", { name: "Leaderboards" })).toHaveAttribute("href", "/scores");
        await expect(exploreLinks.getByRole("link", { name: "Statistics" })).toHaveAttribute("href", "/stats");
        const projectLinks = footer.getByRole("navigation", { name: "Project footer links" });
        await expect(projectLinks.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs");
        await expect(projectLinks.getByRole("link", { name: /GitHub/ })).toHaveAttribute("href", "https://github.com/riscv-prg32/PRG32");
        const linkGeometry = await footer.getByRole("navigation", { name: "Explore footer links" }).getByRole("link").evaluateAll((links) => links.map((link) => {
          const rect = link.getBoundingClientRect();
          return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
        }));
        expect(linkGeometry).toHaveLength(3);
        for (let index = 1; index < linkGeometry.length; index += 1) {
          expect(linkGeometry[index].top, `footer link ${index} starts below the previous link`).toBeGreaterThan(linkGeometry[index - 1].bottom);
        }
        const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
        expect(noHorizontalOverflow, `home footer at ${width}px/${theme}`).toBe(true);
        if (process.env.PRG32_UI11_VISUAL === "1" && (width === 375 || width === 1440)) {
          await page.screenshot({ path: `/tmp/prg32-ui11-${width === 375 ? "mobile" : "desktop"}-${theme}.png`, fullPage: true });
        }
      }
    }

    for (const path of footerRoutes) {
      await page.goto(path);
      await expect(page.getByRole("contentinfo")).toHaveCount(1);
      await expect(page.getByRole("contentinfo").getByRole("heading", { name: "EXPLORE" })).toBeVisible();
      await expect(page.getByRole("contentinfo").getByRole("link", { name: /GitHub/ })).toBeVisible();
    }

    expect(pageErrors).toEqual([]);
  });

  test("keeps the header sticky, offsets catalog anchors and preserves mobile menu behavior", async ({ page }) => {
    test.setTimeout(120_000);
    const stickyTop = async () => Math.round(await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().top));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Build cartridges/ })).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect.poll(stickyTop).toBe(0);
    if (process.env.PRG32_UI111_VISUAL === "1") await page.screenshot({ path: "/tmp/prg32-ui111-desktop-top.png" });
    await page.evaluate(() => window.scrollTo({ top: Math.min(900, document.documentElement.scrollHeight), behavior: "instant" }));
    await expect.poll(stickyTop).toBe(0);
    if (process.env.PRG32_UI111_VISUAL === "1") await page.screenshot({ path: "/tmp/prg32-ui111-desktop-scrolled.png" });

    await page.goto("/explore#catalog-search");
    const anchorMetrics = await page.evaluate(() => {
      const header = document.querySelector("header")?.getBoundingClientRect();
      const target = document.querySelector("#catalog-search")?.getBoundingClientRect();
      return { headerBottom: header?.bottom ?? -1, targetTop: target?.top ?? -1, viewportHeight: window.innerHeight };
    });
    expect(anchorMetrics.targetTop).toBeGreaterThanOrEqual(anchorMetrics.headerBottom - 1);
    expect(anchorMetrics.targetTop).toBeLessThan(anchorMetrics.viewportHeight);

    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Build cartridges/ })).toBeVisible();
    await expect.poll(stickyTop).toBe(0);
    if (process.env.PRG32_UI111_VISUAL === "1") await page.screenshot({ path: "/tmp/prg32-ui111-mobile-top.png" });
    await page.evaluate(() => window.scrollTo({ top: Math.min(600, document.documentElement.scrollHeight), behavior: "instant" }));
    await expect.poll(stickyTop).toBe(0);
    if (process.env.PRG32_UI111_VISUAL === "1") await page.screenshot({ path: "/tmp/prg32-ui111-mobile-scrolled.png" });
    const menuTrigger = page.getByRole("button", { name: "Open navigation" });
    await menuTrigger.click();
    await expect(page.getByRole("navigation", { name: "Mobile primary navigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menuTrigger).toBeFocused();
    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).resolves.toBe(true);
  });

  test("supports Explore search, architecture filtering and pagination with isolated fixtures", async ({ page }) => {
    await page.route("**/api/games**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== "/api/games") return route.continue();
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      await fulfillJson(route, {
        ok: true,
        games: pageNumber === 1 ? [
          syntheticGame({ id: "org.example.ui91-qemu", title: "QEMU Demo", architectures: ["qemu"] }),
          syntheticGame({ id: "org.example.ui91-c6", title: "C6 Demo", architectures: ["esp32c6"] }),
        ] : [],
        pagination: pagination(pageNumber),
      });
    });

    await page.goto("/explore");
    await expect(page.locator("#catalog").getByRole("link", { name: "Open QEMU Demo" })).toBeVisible();
    await page.locator('input[name="desktop-architecture-filter"][value="esp32c6"]').click();
    await expect(page).toHaveURL(/architecture=esp32c6/);
    await expect(page.locator("#catalog").getByRole("link", { name: "Open C6 Demo" })).toBeVisible();
    await expect(page.locator("#catalog").getByRole("link", { name: "Open QEMU Demo" })).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/\/explore\?.*architecture=esp32c6.*page=2|\/explore\?.*page=2.*architecture=esp32c6/);
    await expect(page.getByText("2 cartridges found")).toBeVisible();
  });

  test("renders positive public catalog, game detail, scores, statistics and profile fixtures", async ({ page }) => {
    await page.route("**/api/games**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/games/org.example.ui91") return fulfillJson(route, { ok: true, game: syntheticGame() });
      if (url.pathname === "/api/games") return fulfillJson(route, { ok: true, games: [syntheticGame()], pagination: { ...pagination(), total: 1, pages: 1, has_next: false, next_page: null } });
      return route.continue();
    });
    await page.route("**/api/scores**", (route) => fulfillJson(route, [{ game: "org.example.ui91", player: "Synthetic player", score: 42, created_at: 1_728_000_000, submitted_by: "anonymous" }]));
    await page.route("**/api/stats/downloads**", (route) => fulfillJson(route, { series: [{ date: "2026-10-16", downloads: 2 }], total: 2, top_games: [{ id: "org.example.ui91", title: "UI.9.1 Demo", downloads: 2, last_published: null }] }));
    await page.route("**/api/stats/scores**", (route) => fulfillJson(route, { scores: [{ game: "org.example.ui91", player: "Synthetic player", score: 42, created_at: 1_728_000_000, submitted_by: "anonymous" }] }));
    await page.route("**/api/stats/runs**", (route) => fulfillJson(route, { total: 1, finished: 1, active_last_7_days: 1 }));
    await page.route("**/api/users/ui91-public-profile", (route) => fulfillJson(route, { ok: true, user: { username: "ui91-public-profile", role: "viewer", created_at: "2026-10-16" }, run_count: 0, can_view_runs: false }));

    await page.goto("/explore");
    await expect(page.locator("#catalog").getByRole("link", { name: "Open UI.9.1 Demo" })).toBeVisible();
    await page.goto("/games/org.example.ui91");
    await expect(page.getByRole("heading", { name: "UI.9.1 Demo" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download qemu" })).toHaveAttribute("href", /architecture=qemu/);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);

    await page.goto("/scores");
    await expect(page.getByRole("heading", { name: "Returned scores" })).toBeVisible();
    await expect(page.getByText("Synthetic player")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toHaveCount(1);

    await page.goto("/stats");
    await expect(page.getByText("Recorded downloads")).toBeVisible();
    await expect(page.getByText("UI.9.1 Demo")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toHaveCount(1);

    await page.goto("/users/ui91-public-profile");
    await expect(page.getByRole("heading", { name: "ui91-public-profile" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
  });

  test("keeps public missing-resource and API-error states bounded", async ({ page }) => {
    await page.goto("/games/ui91-missing-fixture");
    await expect(page.getByText(/Cartridge not found|The catalog could not be loaded\./)).toBeVisible();

    await page.goto("/users/ui91-missing-fixture");
    await expect(page.getByText(/requested user or run was not found|profile service could not be reached/i)).toBeVisible();

    await page.goto("/docs/not-a-real-documentation-slug");
    await expect(page.getByText("Cartridge not found")).toBeVisible();
  });
});
