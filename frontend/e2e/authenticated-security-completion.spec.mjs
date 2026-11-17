import { expect, test } from "@playwright/test";

const completionMode = process.env.PRG32_UI931_COMPLETION === "1";
const backendUrl = process.env.PRG32_UI93_BACKEND_URL;
const userPassword = "ui93-disposable-password-2026";
const adminPassword = "ui93-disposable-admin-password-2026";

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

async function authenticatedStatus(page) {
  return page.evaluate(async () => (await fetch("/api/auth/me", { cache: "no-store" })).status);
}

async function bearerStatus(secret) {
  if (!backendUrl) throw new Error("PRG32_UI93_BACKEND_URL is required for token acceptance");
  return (await fetch(`${backendUrl}/auth/me`, { headers: { authorization: `Bearer ${secret}` } })).status;
}

async function waitForServerExpiry(page, timeoutMs = 75_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await authenticatedStatus(page) === 401) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error("The disposable server session did not expire within the bounded acceptance window.");
}

async function setTheme(page, theme) {
  const current = await page.locator("html").getAttribute("data-theme");
  if (current !== theme) {
    await page.getByRole("button", { name: `Switch to ${theme === "dark" ? "dark" : "light"} theme` }).click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test.describe("authenticated security completion", () => {
  test.skip(!completionMode, "requires the opt-in completion runtime");

  test("real server session expiry clears private access and permits recovery", async ({ page }) => {
    test.setTimeout(95_000);
    await login(page, "ui93-user-b", userPassword);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    expect(await authenticatedStatus(page)).toBe(200);

    await waitForServerExpiry(page);
    expect(await authenticatedStatus(page)).toBe(401);

  await page.goto("/dashboard/account");
    await expect(page).toHaveURL(/\/login\?reason=(required|expired)/);
    await expect(page.getByText(/session expired|sign in is required/i)).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Build cartridges/i })).toBeVisible();

    await login(page, "ui93-user-b", userPassword);
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    expect(await authenticatedStatus(page)).toBe(200);
    await logout(page);
  });

  test("token revocation and identity switching never expose private secrets", async ({ page }) => {
    await login(page, "ui93-user-a", userPassword);
    const label = "ui931-revocation-token";
    await page.getByLabel("Token label").fill(label);
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByText("New token:")).toBeVisible();
    const secret = (await page.locator("code").first().textContent())?.trim();
    expect(secret).toBeTruthy();
    expect(await bearerStatus(secret)).toBe(200);

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("New token:")).not.toBeVisible();
    const tokenInput = page.locator(`input[value="${label}"]`).first();
    const tokenRow = tokenInput.locator("xpath=ancestor::li[1]");
    await expect(tokenRow).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await tokenRow.getByRole("button", { name: "Revoke" }).click();
    await expect(tokenInput).not.toBeVisible();
    expect(await bearerStatus(secret)).toBe(401);

    await logout(page);
    await login(page, "ui93-user-b", userPassword);
    await expect(page.locator(`input[value="${label}"]`)).not.toBeVisible();
    expect(await page.evaluate(async () => (await fetch("/api/auth/tokens")).status)).toBe(200);
    await logout(page);
  });

  test("rejects an incorrect password-change secret without losing the session", async ({ page }) => {
    await login(page, "ui93-user-b", userPassword);
    await page.getByLabel("Current password").fill("ui931-incorrect-password");
    await page.getByLabel("New password").fill("ui931-new-password");
    await page.getByLabel("Confirm password").fill("ui931-new-password");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password change failed", { exact: false })).toBeVisible();
    expect(await authenticatedStatus(page)).toBe(200);
    await logout(page);
  });

  test("authenticated controls expose labels and keyboard focus", async ({ page }) => {
    await login(page, "ui93-admin", adminPassword);
    await expect(page.getByLabel("Current password")).toBeVisible();
    await expect(page.getByLabel("Token label")).toBeVisible();
    await page.getByLabel("Token label").focus();
    expect(await page.getByLabel("Token label").evaluate((element) => element === document.activeElement)).toBe(true);
    await page.getByRole("button", { name: "Add passkey" }).focus();
    expect(await page.getByRole("button", { name: "Add passkey" }).evaluate((element) => element === document.activeElement)).toBe(true);
    await logout(page);
  });

  test("performs real virtual-authenticator registration, login and management", async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const dialogHandler = async (dialog) => {
      if (dialog.type() === "prompt" && /current password/i.test(dialog.message())) {
        await dialog.accept(userPassword);
      } else if (dialog.type() === "prompt" && dialog.defaultValue() === "UI931 virtual authenticator") {
        await dialog.accept("UI931 renamed authenticator");
      } else if (dialog.type() === "prompt") {
        await dialog.accept("UI931 virtual authenticator");
      } else {
        await dialog.accept();
      }
    };
    page.on("dialog", dialogHandler);
    try {
      await login(page, "ui93-user-a", userPassword);
      await page.getByRole("button", { name: "Add passkey" }).click();
      await expect(page.getByText("UI931 virtual authenticator", { exact: true })).toBeVisible();

      await logout(page);
      await page.goto("/login?return_to=%2Fdashboard%2Faccount");
      await page.getByLabel("Username or email").fill("ui93-user-a");
      await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard\/account$/);
      await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
      await expect(page.getByText("UI931 virtual authenticator", { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Rename" }).click();
      await expect(page.getByText("UI931 renamed authenticator", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Remove" }).click();
      const revokedPasskey = page.getByText("UI931 renamed authenticator", { exact: true }).locator("xpath=ancestor::li[1]");
      await expect(revokedPasskey).toContainText("Revoked");
      await expect(revokedPasskey.getByRole("button", { name: "Remove" })).toBeDisabled();
    } finally {
      page.off("dialog", dialogHandler);
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  });

  test("executes the authenticated workspace responsive matrix", async ({ page }) => {
    const widths = [375, 768, 1024, 1440, 1920];
    const workspaces = [
      { route: "/dashboard/account", username: "ui93-admin", password: adminPassword, heading: "Your account" },
      { route: "/admin", username: "ui93-admin", password: adminPassword, heading: "Administration" },
      { route: "/workspace", username: "ui93-creator", password: userPassword, heading: "Creator Studio" },
      { route: "/publish", username: "ui93-creator", password: userPassword, heading: "Submit a cartridge" },
      { route: "/review", username: "ui93-reviewer", password: "ui93-disposable-reviewer-password-2026", heading: "Review submissions" },
    ];
    let combinations = 0;

    for (const workspace of workspaces) {
      await login(page, workspace.username, workspace.password, workspace.route);
      for (const theme of ["light", "dark"]) {
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(workspace.route);
          await expect(page.getByRole("heading", { name: workspace.heading })).toBeVisible();
          await setTheme(page, theme);
          const layout = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            visibleButtons: [...document.querySelectorAll("button")].filter((button) => button.getClientRects().length > 0).length,
          }));
          expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
          expect(layout.visibleButtons).toBeGreaterThan(0);
          combinations += 1;
        }
      }
      await logout(page);
    }

    expect(combinations).toBe(50);
  });
});
