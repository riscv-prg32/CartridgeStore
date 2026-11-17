import fs from "node:fs";

import { expect, test } from "@playwright/test";

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const PASSWORD = "browser-fixture-password-2026";

async function login(page, username, password) {
  await page.goto(`${storeOrigin()}/login`);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname.endsWith("/auth/login") && candidate.request().method() === "POST");
  await Promise.all([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  expect((await response).status()).toBe(200);
}

function capturedMessages() {
  const file = process.env.PRG32_M52G14_SMTP_CAPTURE_PATH;
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).raw);
}

async function waitForLink(pathname, messageOffset = 0) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const link = capturedMessages().slice(messageOffset).flatMap((message) => message.match(/https?:\/\/[^\s<]+/g) ?? []).find((candidate) => candidate.includes(pathname));
    if (link) return link.replace(/[)>.,]+$/u, "");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No disposable SMTP link captured for ${pathname}`);
}

async function configureSmtp(page) {
  await page.goto(`${storeOrigin()}/admin`);
  await page.getByLabel("smtp.host").fill(process.env.PRG32_M52G14_SMTP_HOST || "127.0.0.1");
  await page.getByLabel("smtp.port").fill(process.env.PRG32_M52G14_SMTP_PORT);
  await page.getByLabel("smtp.from_email").fill("store@example.test");
  const enabled = page.locator("label").filter({ hasText: "SMTP enabled" }).getByRole("checkbox");
  if (!(await enabled.isChecked())) await enabled.check();
  const registration = page.locator("label").filter({ hasText: "Registration enabled" }).getByRole("checkbox");
  if (!(await registration.isChecked())) await registration.check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings salvate");
}

test("completes registration and password reset through the disposable SMTP capture", async ({ page }) => {
  await login(page, "browser-admin", PASSWORD);
  await configureSmtp(page);

  const suffix = Date.now();
  const username = `smtp-user-${suffix}`;
  const email = `${username}@example.test`;
  const userPassword = "smtp-user-password-2026";
  await page.goto(`${storeOrigin()}/register`);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(userPassword);
  await page.getByLabel("Confirm password").fill(userPassword);
  const registrationMessageOffset = capturedMessages().length;
  await page.getByRole("button", { name: "Request verification email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const registrationLink = await waitForLink("/register/complete", registrationMessageOffset);

  await page.goto(registrationLink);
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(userPassword);
  await page.getByLabel("Confirm password").fill(userPassword);
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);

  await page.goto(registrationLink);
  await page.waitForLoadState("networkidle");
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(userPassword);
  await page.getByLabel("Confirm password").fill(userPassword);
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page.getByText("Check the submitted registration details.", { exact: true })).toBeVisible();

  await page.goto(`${storeOrigin()}/forgot-password`);
  await page.getByLabel("Email or username").fill(email);
  const resetMessageOffset = capturedMessages().length;
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("If the account is eligible, a reset link has been sent.")).toBeVisible();
  const resetLink = await waitForLink("/password-reset", resetMessageOffset);
  const newPassword = "smtp-user-password-reset-2026";
  await page.goto(resetLink);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("New password").fill(newPassword);
  await page.getByLabel("Confirm password").fill(newPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password reset complete.")).toBeVisible();
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await login(page, username, newPassword);
  expect(await page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);
});

test("keeps hidden and unpublished cartridges in the admin moderation inventory", async ({ page }) => {
  await login(page, "browser-admin", PASSWORD);
  await page.goto(`${storeOrigin()}/admin`);
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first();
  await row.click();
  await page.getByLabel("Reason").fill("M5.2g.30 hidden fixture");
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first()).toContainText("hidden");
  await page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first().click();
  await page.getByRole("button", { name: "Restore visibility" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first()).toContainText("visible");
  await page.getByLabel("Reason").fill("M5.2g.30 unpublished fixture");
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first()).toContainText("unpublished");
  await page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first().click();
  await page.getByRole("button", { name: "Restore visibility" }).click();
  await expect(page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).first()).toContainText("visible");
});

test("supports deterministic admin user search and pagination controls", async ({ page }) => {
  await login(page, "browser-admin", PASSWORD);
  await page.goto(`${storeOrigin()}/admin`);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByLabel("Search users").fill("browser-admin");
  await expect(page.locator("tbody tr").filter({ hasText: "browser-admin" })).toBeVisible();
  await page.getByLabel("Search users").fill("no-such-disposable-user");
  await expect(page.getByText("No users match this search.")).toBeVisible();
  await page.getByLabel("Search users").fill("browser-admin");
  await expect(page.locator("tbody tr").filter({ hasText: "browser-admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
});
