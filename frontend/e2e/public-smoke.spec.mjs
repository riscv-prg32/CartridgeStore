import { expect, test } from "@playwright/test";

test.describe("public storefront smoke", () => {
  test("renders the homepage and its primary public routes", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Build cartridges\. Learn the machine\./ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Explore cartridges/ })).toHaveAttribute("href", "/explore");

    await page.goto("/docs");
    await expect(page.getByRole("heading", { name: "Build for PRG32" })).toBeVisible();

    await page.goto("/login");
    await expect(page.getByRole("heading", { name: /Sign in|Authentication is disabled/ })).toBeVisible();
  });

  test("preserves explore query parameters without requiring catalog seed data", async ({ page }) => {
    await page.goto("/explore?q=classroom&sort=updated");
    await expect(page).toHaveURL(/\/explore\?q=classroom&sort=updated$/);
    await expect(page.getByRole("heading", { name: "Browse the cartridge shelf." })).toBeVisible();
    await expect(page.getByRole("search")).toBeVisible();
  });

  test("renders a stable missing-cartridge state or bounded API error", async ({ page }) => {
    await page.goto("/games/ui8-missing-fixture");
    await expect(page.getByText(/Cartridge not found|The catalog could not be loaded\./)).toBeVisible();
  });

  test("persists the theme choice and avoids mobile horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: /Switch to (light|dark) theme/ });
    const initialTheme = await page.locator("html").getAttribute("data-theme");
    await toggle.click();
    const nextTheme = initialTheme === "dark" ? "light" : "dark";
    await expect(page.locator("html")).toHaveAttribute("data-theme", nextTheme);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", nextTheme);

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(overflow).toBe(true);

    const resetToggle = page.getByRole("button", { name: /Switch to (light|dark) theme/ });
    await resetToggle.click();
  });
});
