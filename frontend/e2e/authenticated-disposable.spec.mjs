import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const backendUrl = process.env.PRG32_UI93_BACKEND_URL;
const bootstrapToken = process.env.PRG32_UI93_TEST_BOOTSTRAP_TOKEN;
const userPassword = "ui93-disposable-password-2026";
const adminPassword = "ui93-disposable-admin-password-2026";
const reviewerPassword = "ui93-disposable-reviewer-password-2026";
const registrationUsername = "ui93-browser-registration";
const registrationEmail = "ui93-browser-registration@example.test";
const registrationPassword = "ui93-browser-registration-password-2026";

test.describe.configure({ mode: "serial" });

async function login(page, username, password, returnTo = "/dashboard/account") {
  await page.goto(`/login?return_to=${encodeURIComponent(returnTo)}`);
  await page.getByLabel("Username or email").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${returnTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}

async function logout(page) {
  await page.getByRole("button", { name: /Open account menu for/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

async function submissionBundle(id = "org.example.ui93", title = "UI.9.3 Acceptance Cartridge") {
  const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
  const { zipSync } = requireBackend("fflate");
  const cartridge = Buffer.alloc(84);
  cartridge.write("PRG2", 0, "ascii");
  cartridge.writeUInt16LE(1, 4);
  cartridge.writeUInt16LE(72, 8);
  cartridge.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(cartridge, 72);
  return Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify({
      abi: "prg32-metadata-1.0",
      id,
      title,
      version: "1.0.0",
      authors: [{ name: "PRG32 UI.9.3" }],
      tags: ["ui93", "disposable"],
      assets: { icon: "icon.png" },
      architectures: [{ id: "qemu", file: "game-qemu.prg32" }],
    })),
    "icon.png": Buffer.from("89504e470d0a1a0a", "hex"),
    "game-qemu.prg32": cartridge,
  }));
}

test("local registration, login, logout and real authenticated account", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Username").fill(registrationUsername);
  await page.getByLabel("Email").fill(registrationEmail);
  await page.getByLabel("Password", { exact: true }).fill(registrationPassword);
  await page.getByLabel("Confirm password").fill(registrationPassword);
  await page.getByRole("button", { name: "Request verification email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const messages = await page.request.get(`${backendUrl}/api/_test/email/messages`, { headers: { "x-prg32-bootstrap-token": bootstrapToken } });
  expect(messages.ok()).toBeTruthy();
  const payload = await messages.json();
  const message = payload.messages.at(-1);
  expect(message?.to).toBe(registrationEmail);
  const token = new URL(message.text.match(/https?:\/\/\S+/u)[0]).searchParams.get("token");
  expect(token).toBeTruthy();

  await page.goto(`/register/complete?token=${encodeURIComponent(token)}`);
  await page.getByLabel("Password", { exact: true }).fill(registrationPassword);
  await page.getByLabel("Confirm password").fill(registrationPassword);
  await page.getByRole("button", { name: "Complete registration" }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  expect((await page.context().cookies()).some((cookie) => cookie.name === "prg32_ts_session")).toBeTruthy();
  expect(await page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText(registrationUsername, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();

  await logout(page);
  await page.goto("/dashboard/account");
  await expect(page).toHaveURL(/\/login\?reason=required/);
});

test("identity isolation, CSRF-backed token mutation and password change", async ({ page }) => {
  await login(page, "ui93-user-a", userPassword);
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  await page.getByLabel("Token label").fill("ui93-user-a-token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("New token:")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("New token:")).not.toBeVisible();

  await logout(page);

  await login(page, "ui93-user-b", userPassword);
  await expect(page.getByRole("heading", { name: "API tokens" })).toBeVisible();
  await expect(page.getByText("ui93-user-a-token", { exact: true })).not.toBeVisible();
  await logout(page);
});

test("RBAC separates ordinary users, reviewers and administrators", async ({ page }) => {
  await login(page, "ui93-rbac", userPassword, "/admin");
  await expect(page.getByRole("heading", { name: "No administrative permissions" })).toBeVisible();
  const denied = await page.evaluate(async () => (await fetch("/api/admin/users")).status);
  expect(denied).toBe(403);
  await logout(page);

  await login(page, "ui93-admin", adminPassword, "/admin");
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByText("Users", { exact: true })).toBeVisible();
  await logout(page);

  await login(page, "ui93-reviewer", reviewerPassword, "/review");
  await expect(page.getByRole("heading", { name: "Review submissions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "pending", exact: true })).toBeVisible();
});

test("account menu follows backend permissions on mobile and desktop", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const identities = [
    { username: "ui93-user-a", password: userPassword },
    { username: "ui93-creator", password: userPassword },
    { username: "ui93-reviewer", password: reviewerPassword },
    { username: "ui93-admin", password: adminPassword },
  ];

  for (const identity of identities) {
    await login(page, identity.username, identity.password);
    await page.evaluate(() => window.scrollTo({ top: Math.min(500, document.documentElement.scrollHeight), behavior: "instant" }));
    await expect.poll(() => page.getByRole("banner").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    const permissions = await page.evaluate(async () => (await fetch("/api/auth/me")).json()).then((body) => body.user.permissions ?? []);
    await page.getByRole("button", { name: `Open account menu for ${identity.username}` }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Your account" })).toBeVisible();
    const expectedItems = [
      ["Creator Studio", permissions.includes("catalog:submit")],
      ["Review queue", ["submissions:read", "submissions:review", "submissions:reject"].some((permission) => permissions.includes(permission))],
      ["Administration", ["settings:read", "users:read", "groups:read", "roles:read", "tokens:read:any", "backup:export", "federation:read"].some((permission) => permissions.includes(permission))],
    ];
    for (const [label, visible] of expectedItems) {
      if (visible) await expect(menu.getByRole("menuitem", { name: label })).toBeVisible();
      else await expect(menu.getByRole("menuitem", { name: label })).toHaveCount(0);
    }
    await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await logout(page);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "ui93-admin", adminPassword);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
  await expect(page.getByRole("contentinfo").getByRole("link", { name: /GitHub/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open account menu for ui93-admin" })).toBeVisible();
  await logout(page);
});

test("creator draft and publishing workflow use real disposable Fastify writes", async ({ page }) => {
  const bundle = await submissionBundle();
  await login(page, "ui93-creator", userPassword, "/workspace");
  await expect(page.getByRole("heading", { name: "Creator Studio" })).toBeVisible();
  await page.getByRole("button", { name: "New draft" }).click();
  await expect(page.getByText("New cartridge draft")).toBeVisible();
  const draftInput = page.locator('input[aria-label^="Attach ZIP to draft"]');
  const attachResponse = page.waitForResponse((response) => response.url().includes("/api/drafts/") && response.url().endsWith("/artifact") && response.request().method() === "POST");
  await draftInput.setInputFiles({ name: "ui93-acceptance.zip", mimeType: "application/zip", buffer: bundle });
  const attached = await attachResponse;
  if (attached.status() !== 200) throw new Error(`draft artifact attach returned HTTP ${attached.status()}: ${await attached.text()}`);
  await expect(page.getByText("bundle attached")).toBeVisible();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.getByText("Draft submitted for review.")).toBeVisible();

  await page.goto("/publish");
  await expect(page.getByRole("heading", { name: "Submit a cartridge" })).toBeVisible();
  await page.getByRole("button", { name: "Choose bundle" }).click();
  await page.getByLabel("Cartridge bundle").setInputFiles({ name: "ui93-wizard.zip", mimeType: "application/zip", buffer: await submissionBundle("org.example.ui93.wizard", "UI.9.3 Wizard Cartridge") });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Server-side validation" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review and submit" })).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("heading", { name: "Submission received" })).toBeVisible();
  await logout(page);

  await login(page, "ui93-reviewer", reviewerPassword, "/review");
  await expect(page.getByRole("heading", { name: "Review submissions" })).toBeVisible();
  const pending = page.locator('button').filter({ hasText: "UI.9.3 Acceptance Cartridge" }).first();
  await expect(pending).toBeVisible();
  await pending.click();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("The submission status was updated.")).toBeVisible();
});

test("authenticated surfaces remain usable across supported widths and themes", async ({ page }) => {
  await login(page, "ui93-admin", adminPassword, "/dashboard/account");
  for (const width of [375, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
  await page.goto("/dashboard/account");
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    const themeToggle = page.getByRole("button", { name: /Switch to (light|dark) theme/ });
    await themeToggle.click();
    await expect(themeToggle).toBeVisible();
  }
});

test("password change is a real CSRF-protected authenticated mutation", async ({ page }) => {
  await login(page, "ui93-user-b", userPassword);
  await page.getByLabel("Current password").fill(userPassword);
  await page.getByLabel("New password").fill("ui93-user-b-new-password-2026");
  await page.getByLabel("Confirm password").fill("ui93-user-b-new-password-2026");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed and other sessions were signed out.")).toBeVisible();
});
