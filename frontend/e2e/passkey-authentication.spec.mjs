import { expect, test } from "@playwright/test";

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const PASSWORD = "browser-fixture-password-2026";

async function login(page) {
  await page.goto(`${storeOrigin()}/login`);
  await page.getByLabel("Username or email").fill("browser-admin");
  await page.getByLabel("Password").fill(PASSWORD);
  const response = page.waitForResponse((candidate) => {
    const pathname = new URL(candidate.url()).pathname;
    return (pathname.endsWith("/auth/login") || pathname.endsWith("/api/auth/login")) && candidate.request().method() === "POST";
  });
  await Promise.all([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  expect((await response).status()).toBe(200);
}

test("registers, lists, and uses a disposable resident passkey", async ({ context, page }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, automaticPresenceSimulation: true, isUserVerified: true } });

  await login(page);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  let prompt = 0;
  page.on("dialog", async (dialog) => {
    prompt += 1;
    await dialog.accept(prompt === 1 ? PASSWORD : "Browser resident passkey");
  });
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Browser resident passkey", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await page.getByRole("button", { name: "Use a discoverable passkey" }).click();
  await expect(page).toHaveURL(/\/dashboard\/account$/);
  expect(await page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);
});
