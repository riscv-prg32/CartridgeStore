import { expect, test } from "@playwright/test";

test.describe("disposable Next.js + Fastify integration", () => {
  test("renders real catalog, detail, scores, statistics and profile responses", async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/explore");
    await expect(page.getByRole("heading", { name: "Browse the cartridge shelf." })).toBeVisible();
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Alpha Cartridge" })).toBeVisible();
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Beta Media" })).toBeVisible();

    await page.goto("/explore?q=alpha");
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Alpha Cartridge" })).toBeVisible();
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Beta Media" })).toHaveCount(0);

    await page.goto("/explore");
    await page.locator('input[name="desktop-architecture-filter"][value="esp32c6"]').click();
    await expect(page).toHaveURL(/architecture=esp32c6/);
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Alpha Cartridge" })).toBeVisible();
    await expect(page.locator("#catalog").getByRole("link", { name: "Open Beta Media" })).toHaveCount(0);

    await page.goto("/games/org.example.alpha?version=2.0.0");
    await expect(page.getByRole("heading", { name: "Alpha Cartridge" })).toBeVisible();
    await page.getByRole("combobox", { name: "Architecture" }).click();
    await page.getByRole("option", { name: "qemu" }).click();
    await expect(page.getByRole("link", { name: "Download qemu" })).toHaveAttribute("href", /architecture=qemu/);

    await page.goto("/scores");
    await expect(page.getByRole("heading", { name: "Returned scores" })).toBeVisible();
    await expect(page.getByText("fixture")).toBeVisible();

    await page.goto("/stats");
    await expect(page.getByText("Recorded downloads")).toBeVisible();
    await expect(page.getByText("Alpha Cartridge")).toBeVisible();
    await expect(page.getByText("Metrics runs")).toBeVisible();

    await page.goto("/users/fixture-user");
    await expect(page.getByRole("heading", { name: "fixture-user" })).toBeVisible();
    await expect(page.getByText(/Runs: 0/)).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test("renders real empty, missing and API-error states without browser mocks", async ({ page }) => {
    await page.goto("/explore?q=does-not-exist");
    await expect(page.getByText("No cartridges match this search.")).toBeVisible();
    await expect(page.getByText("0 cartridges found")).toBeVisible();

    await page.goto("/games/does-not-exist");
    await expect(page.getByText("The catalog could not be loaded.")).toBeVisible();

    await page.goto("/games/org.example.alpha?version=9.9.9");
    await expect(page.getByText("The catalog could not be loaded.")).toBeVisible();

    await page.goto("/users/does-not-exist");
    await expect(page.getByText(/requested user or run was not found/i)).toBeVisible();
  });

  test("keeps same-origin proxy and representative responsive rendering on real data", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    const requests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await page.goto("/explore");
    await expect(page.getByRole("heading", { name: "Browse the cartridge shelf." })).toBeVisible();
    const origins = [...new Set(requests.map((url) => new URL(url).origin))];
    expect(origins).toEqual([new URL(page.url()).origin]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/stats");
    await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});
