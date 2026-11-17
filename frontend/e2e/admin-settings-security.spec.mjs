import { expect, test } from "@playwright/test";

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const PASSWORD = "browser-fixture-password-2026";
const TARGET_PASSWORD = "browser-target-password-2026";

async function login(page, username, password) {
  await page.goto(`${storeOrigin()}/login`);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password").fill(password);
  const response = page.waitForResponse((candidate) => {
    const pathname = new URL(candidate.url()).pathname;
    return (pathname.endsWith("/auth/login") || pathname.endsWith("/api/auth/login")) && candidate.request().method() === "POST";
  });
  await Promise.all([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  const result = await response;
  expect(result.status()).toBe(200);
  return { response: result, headers: await result.allHeaders() };
}

async function adminCsrf(page) {
  const response = await page.evaluate(async () => {
    const csrf = await fetch("/auth/csrf");
    return { status: csrf.status, body: await csrf.json() };
  });
  expect(response.status).toBe(200);
  return response.body.csrf_token;
}

test("closes disposable administrative acceptance for settings, users, moderation and audit", async ({ browser, context, page }) => {
  await login(page, "browser-admin", PASSWORD);
  await page.goto(`${storeOrigin()}/admin`);
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();

  await page.getByLabel("session.lifetime_seconds").fill("60");
  const registration = page.locator("label").filter({ hasText: "Registration enabled" }).getByRole("checkbox");
  if (await registration.isChecked()) await registration.uncheck();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings salvate");
  const persistedSettings = await page.evaluate(async () => (await fetch("/api/admin/settings")).json());
  expect(persistedSettings.application_settings["session.lifetime_seconds"].value).toBe(60);
  await page.reload();
  await expect(page.getByLabel("session.lifetime_seconds")).toHaveValue("60");
  await expect(registration).not.toBeChecked();

  const registrationAttempt = await page.evaluate(async () => {
    const csrf = await fetch("/api/auth/csrf").then((response) => response.json());
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrftoken": csrf.csrf_token,
      },
      body: JSON.stringify({
        username: "closed-browser-user",
        email: "closed-browser-user@example.test",
        password: "long-password-123",
        password_confirm: "long-password-123",
      }),
    });
    return response.status;
  });
  expect(registrationAttempt).toBe(400);

  await registration.check();
  await page.getByLabel("smtp.host").fill(process.env.PRG32_M52G14_SMTP_HOST || "127.0.0.1");
  await page.getByLabel("smtp.port").fill(process.env.PRG32_M52G14_SMTP_PORT);
  await page.getByLabel("smtp.from_email").fill("store@example.test");
  const smtpEnabled = page.locator("label").filter({ hasText: "SMTP enabled" }).getByRole("checkbox");
  if (!(await smtpEnabled.isChecked())) await smtpEnabled.check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings salvate");
  await page.getByRole("button", { name: "Test SMTP connection" }).click();
  await expect(page.getByRole("status")).toContainText("SMTP connection accepted.");
  await page.getByLabel("Test recipient").fill("acceptance@example.test");
  await page.getByRole("button", { name: "Send test message" }).click();
  await expect(page.getByRole("status")).toContainText("SMTP test message accepted.");
  await page.getByRole("button", { name: /Sign out/ }).click();
  await login(page, "browser-admin", PASSWORD);
  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "prg32_ts_session");
  expect(sessionCookie).toBeTruthy();
  expect(sessionCookie.expires).toBeGreaterThan(Date.now() / 1000);
  expect(sessionCookie.expires).toBeLessThan(Date.now() / 1000 + 61);

  await page.goto(`${storeOrigin()}/admin`);
  await page.getByLabel("session.lifetime_seconds").fill("600");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toContainText("Settings salvate");
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByLabel("Username").fill("browser-target");
  await page.getByLabel("Email").fill("browser-target@example.test");
  await page.getByLabel("Password").fill(TARGET_PASSWORD);
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.locator("tbody").getByText("browser-target", { exact: true })).toBeVisible();

  const targetContext = await browser.newContext();
  const targetPage = await targetContext.newPage();
  await login(targetPage, "browser-target", TARGET_PASSWORD);
  await page.locator("tbody tr").filter({ hasText: "browser-target" }).click();
  await page.getByRole("button", { name: "Suspend" }).click();
  await expect(page.getByText(/Current status:/)).toContainText("suspended");
  expect(await targetPage.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);

  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByRole("combobox").selectOption("publisher");
  await expect(page.getByRole("combobox")).toHaveValue("publisher");
  await page.getByRole("button", { name: "Ban" }).click();
  await expect(page.getByText(/Current status:/)).toContainText("banned");
  expect(await targetPage.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);
  await targetContext.close();

  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.locator("tbody tr").filter({ hasText: "Browser Fixture" }).click();
  await page.getByLabel("Reason").fill("Disposable acceptance hide");
  await page.getByRole("button", { name: "Hide" }).click();
  await page.goto(`${storeOrigin()}/`);
  await expect(page.getByText("Browser Fixture")).not.toBeVisible();

  const csrf = await adminCsrf(page);
  const restore = await page.evaluate(async (token) => {
    const response = await fetch(
      "/api/admin/cartridges/browser-fixture/moderation?version=1.0.0",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrftoken": token,
        },
        body: JSON.stringify({
          action: "restored",
          reason: "Disposable acceptance restore",
        }),
      },
    );
    return response.status;
  }, csrf);
  expect(restore).toBe(200);
  await page.goto(`${storeOrigin()}/`);
  await expect(page.getByText("Browser Fixture")).toBeVisible();

  await page.goto(`${storeOrigin()}/admin`);
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByText("settings.update", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("user.account.suspended", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("catalog.moderation.hidden", { exact: true }).first()).toBeVisible();
});
