import { expect, test } from "@playwright/test";

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const BOOTSTRAP_TOKEN = "m534-disposable-operational-bootstrap-token";
const ADMIN_PASSWORD = "m537-browser-admin-password-2026";

async function saveStep(page) {
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
}

test("completes a fresh first-installation wizard and rejects setup replay", async ({ page }) => {
  await page.goto(`${storeOrigin()}/setup`);
  if (process.env.PRG32_M537_SETUP_E2E !== "1") {
    await expect(page.getByRole("heading", { name: "Installation already complete" })).toBeVisible();
    return;
  }
  await expect(page.getByRole("heading", { name: "First installation" })).toBeVisible();
  await page.getByLabel("Installation authorization").fill(BOOTSTRAP_TOKEN);
  await page.getByRole("button", { name: "Start installation" }).click();

  await page.getByLabel("Username").fill("m537-browser-admin");
  await page.getByLabel("Email").fill("m537-browser-admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Confirm password").fill(ADMIN_PASSWORD);
  await saveStep(page);

  await page.getByLabel("Store name").fill("M5.3.7 Disposable Store");
  await page.getByLabel("Description").fill("First-installation browser fixture");
  await page.getByLabel("Contact email").fill("store@example.test");
  await saveStep(page);

  await saveStep(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();
  await saveStep(page);

  await page.getByLabel("Enable SMTP").check();
  await page.getByLabel("SMTP host").fill("mailpit");
  await page.getByLabel("SMTP port").fill("1025");
  await page.getByLabel("From email").fill("store@example.test");
  await saveStep(page);

  await page.getByLabel("Enable generic OIDC").check();
  await page.getByLabel("Provider ID").fill("m537-oidc");
  await page.getByLabel("Display name").fill("Disposable OIDC");
  await page.getByLabel("Issuer").fill("https://idp.example.test/oidc");
  await page.getByLabel("Client ID").fill("m537-client");
  await page.getByLabel("Client secret").fill("m537-oidc-secret");
  await saveStep(page);

  await page.getByLabel("Enable generic SAML").check();
  await page.getByLabel("Provider ID").fill("m537-saml");
  await page.getByLabel("Display name").fill("Disposable SAML");
  await page.getByLabel("IdP entity ID").fill("https://idp.example.test/saml");
  await page.getByLabel("SSO URL").fill("https://idp.example.test/sso");
  await page.getByLabel("IdP certificate").fill(process.env.PRG32_M537_SAML_CERT ?? "");
  await saveStep(page);

  await saveStep(page);
  await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
  await page.getByRole("button", { name: "Complete installation" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto(`${storeOrigin()}/setup`);
  await expect(page.getByRole("heading", { name: "Installation already complete" })).toBeVisible();

  await page.goto(`${storeOrigin()}/login`);
  await page.getByLabel("Username or email").fill("m537-browser-admin");
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  const response = page.waitForResponse((candidate) => new URL(candidate.url()).pathname.endsWith("/auth/login") && candidate.request().method() === "POST");
  await Promise.all([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  expect((await response).status()).toBe(200);
});
