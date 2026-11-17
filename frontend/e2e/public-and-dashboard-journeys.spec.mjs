import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
const { zipSync } = requireBackend("fflate");

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const PASSWORD = "browser-fixture-password-2026";

function submissionBundle(id = "browser-submission", title = "Browser Submission") {
  const legacy = Buffer.alloc(84);
  legacy.write("PRG2", 0, "ascii");
  legacy.writeUInt16LE(1, 4);
  legacy.writeUInt16LE(72, 8);
  legacy.writeUInt32LE(12, 16);
  Buffer.from("130000001300000013000000", "hex").copy(legacy, 72);
  const icon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAF/gL+KcY5WQAAAABJRU5ErkJggg==", "base64");
  const manifest = {
    abi: "prg32-metadata-1.0",
    id,
    title,
    version: "1.0.0",
    authors: [{ name: "Synthetic Publisher" }],
    tags: ["browser", "acceptance"],
    assets: { icon: "icon.png" },
    architectures: [{ id: "qemu", file: "game-qemu.prg32" }]
  };
  return Buffer.from(zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "icon.png": icon,
    "game-qemu.prg32": legacy
  }));
}

async function loginLocal(page) {
  await page.goto(`${storeOrigin()}/login`);
  await expect(page.getByLabel("Username or email")).toBeVisible();
  await expect(page.getByRole("link", { name: /Disposable OIDC/ })).toBeVisible();
  await page.getByLabel("Username or email").fill("browser-admin");
  await page.getByLabel("Password").fill(PASSWORD);
  const response = page.waitForResponse((candidate) => {
    const pathname = new URL(candidate.url()).pathname;
    return (pathname.endsWith("/auth/login") || pathname.endsWith("/api/auth/login")) && candidate.request().method() === "POST";
  });
  await Promise.all([response, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  expect((await response).status()).toBe(200);
}

async function logoutLocal(page) {
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
}

test("covers public statistics, scores, documentation and PWA assets", async ({ page }) => {
  await page.goto(`${storeOrigin()}/stats`);
  await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
  await expect(page.getByText("Recorded downloads")).toBeVisible();
  await expect(page.getByText("1", { exact: true }).first()).toBeVisible();

  await page.goto(`${storeOrigin()}/scores`);
  await expect(page.getByRole("heading", { name: "Scoreboard" })).toBeVisible();
  await expect(page.getByText("Synthetic Player")).toBeVisible();
  await page.getByLabel("Filter scores by game").fill("browser-fixture");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/game=browser-fixture/);

  await page.goto(`${storeOrigin()}/docs`);
  await expect(page.getByRole("heading", { name: "Build for PRG32" })).toBeVisible();
  await page.getByRole("link", { name: /Read article/ }).first().click();
  await expect(page.getByRole("link", { name: /All documentation/ })).toBeVisible();

  const pwaAssets = await page.evaluate(async () => ({
    manifest: await fetch("/manifest.webmanifest").then(async (response) => ({ status: response.status, body: await response.json() })),
    serviceWorker: await fetch("/static/service-worker.js").then((response) => response.status)
  }));
  expect(pwaAssets.manifest.status).toBe(200);
  expect(pwaAssets.manifest.body.name).toContain("PRG32");
  expect(pwaAssets.serviceWorker).toBe(200);

  await page.goto(`${storeOrigin()}/login?return_to=%2Fstats`);
  await expect(page).toHaveURL(/\/login\?return_to=%2Fstats/);
  const deepLinkPage = await page.context().newPage();
  await deepLinkPage.goto(`${storeOrigin()}/games/browser-fixture`);
  await expect(deepLinkPage.getByRole("heading", { name: "Browser Fixture" })).toBeVisible();
  await deepLinkPage.close();
  await page.goto(`${storeOrigin()}/users/browser-admin`);
  await expect(page.getByRole("heading", { name: "browser-admin" })).toBeVisible();
});

test("covers catalog search, architecture filtering and protected-route denial", async ({ page }) => {
  await page.goto(`${storeOrigin()}/`);
  await page.getByLabel("Search cartridges").fill("Browser Fixture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=Browser(?:%20|\+)Fixture/);
  await expect(page.getByText("Browser Fixture")).toBeVisible();
  await page.getByLabel("Filter by architecture").selectOption("qemu");
  await expect(page).toHaveURL(/q=Browser(?:%20|\+)Fixture.*architecture=qemu/);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).toHaveURL(/store\.m52g14\.test:\d+\/$/);
  await page.goto(`${storeOrigin()}/runs`);
  await expect(page).toHaveURL(/\/login\?reason=required&return_to=%2Fruns/);
});

test("covers account token lifecycle and owner-scoped metrics detail", async ({ page }) => {
  await loginLocal(page);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await page.getByPlaceholder("Firmware client").fill("parity-token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("New token:")).toBeVisible();
  const tokenInputs = page.locator("ul > li input");
  const tokenIndex = await tokenInputs.evaluateAll((inputs) => inputs.findIndex((input) => input.value === "parity-token"));
  expect(tokenIndex).toBeGreaterThanOrEqual(0);
  const tokenRow = page.locator("ul > li").nth(tokenIndex);
  await expect(tokenRow.getByLabel("Label")).toHaveValue("parity-token");
  await tokenRow.getByLabel("Label").fill("parity-token-renamed");
  await tokenRow.getByRole("button", { name: "Rename" }).click();
  await expect(tokenRow.getByLabel("Label")).toHaveValue("parity-token-renamed");

  await page.goto(`${storeOrigin()}/runs`);
  await expect(page.getByRole("heading", { name: "Metrics runs" })).toBeVisible();
  await expect(page.getByText("browser-run-1")).toBeVisible();
  await page.getByRole("link", { name: "browser-run-1" }).click();
  await expect(page.getByRole("heading", { name: "browser-run-1" })).toBeVisible();
  await expect(page.getByText("Download CSV")).toBeVisible();
  await logoutLocal(page);
});

test("covers the publisher submission journey and reviewer publication decision", async ({ page }) => {
  await loginLocal(page);
  await page.goto(`${storeOrigin()}/workspace`);
  await expect(page.getByRole("heading", { name: "browser-admin" })).toBeVisible();
  await page.goto(`${storeOrigin()}/publish`);
  await expect(page.getByRole("heading", { name: "Submit a cartridge" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Cartridge bundle").setInputFiles({ name: "browser-submission.zip", mimeType: "application/zip", buffer: submissionBundle() });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const workflowResponse = page.waitForResponse((candidate) => candidate.url().includes("/api/publish/bundle"));
  await Promise.all([workflowResponse, page.getByRole("button", { name: "Submit for review" }).click()]);
  expect((await workflowResponse).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Submission received" })).toBeVisible();
  await expect(page.getByText("pending review")).toBeVisible();

  await page.goto(`${storeOrigin()}/workspace`);
  await expect(page.getByRole("heading", { name: "browser-submission", exact: true })).toBeVisible();
  await page.goto(`${storeOrigin()}/review`);
  await expect(page.getByRole("heading", { name: "Review submissions" })).toBeVisible();
  await page.getByRole("button", { name: /#\d+ Browser Submission/ }).click();
  await expect(page.getByRole("heading", { name: "Browser Submission" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("The submission status was updated.")).toBeVisible();
  await page.goto(`${storeOrigin()}/`);
  await expect(page.getByText("Browser Submission")).toBeVisible();
  await logoutLocal(page);
});

test("covers reviewer rejection and publisher-visible rejection state", async ({ page }) => {
  await loginLocal(page);
  await page.goto(`${storeOrigin()}/workspace`);
  await expect(page.getByRole("heading", { name: "browser-admin" })).toBeVisible();
  await page.goto(`${storeOrigin()}/publish`);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Cartridge bundle").setInputFiles({ name: "browser-rejected.zip", mimeType: "application/zip", buffer: submissionBundle("browser-rejected", "Browser Rejected") });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const workflowResponse = page.waitForResponse((candidate) => candidate.url().includes("/api/publish/bundle"));
  await Promise.all([workflowResponse, page.getByRole("button", { name: "Submit for review" }).click()]);
  expect((await workflowResponse).status()).toBe(200);
  await page.goto(`${storeOrigin()}/review`);
  await page.getByRole("button", { name: /Browser Rejected/ }).click();
  await expect(page.getByRole("heading", { name: "Browser Rejected" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("The submission status was updated.")).toBeVisible();
  await page.goto(`${storeOrigin()}/workspace`);
  const rejectedSubmission = page.getByText("browser-rejected", { exact: true });
  await expect(rejectedSubmission).toBeVisible();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await logoutLocal(page);
});

test("covers canonical drafts, rejection notes and revision resubmission", async ({ page }) => {
  await loginLocal(page);
  const drafts = page.locator('section[aria-labelledby="drafts-heading"]');
  await page.goto(`${storeOrigin()}/workspace`);
  await expect(drafts.getByRole("heading", { name: "Saved drafts" })).toBeVisible();
  await drafts.getByRole("button", { name: "New draft" }).click();
  const draftRow = drafts.locator("li").filter({ hasText: "New cartridge draft" }).last();
  await expect(draftRow).toContainText("bundle missing");
  await draftRow.locator('input[type="file"]').setInputFiles({ name: "browser-draft.zip", mimeType: "application/zip", buffer: submissionBundle("browser-draft", "Browser Draft Workflow") });
  await expect(draftRow).toContainText("bundle attached");
  const firstSubmit = page.waitForResponse((candidate) => candidate.url().includes("/api/drafts/") && candidate.url().endsWith("/submit"));
  await Promise.all([firstSubmit, draftRow.getByRole("button", { name: "Submit" }).click()]);
  expect((await firstSubmit).status()).toBe(200);

  await page.goto(`${storeOrigin()}/review`);
  const firstReviewItem = page.getByRole("button", { name: /Browser Draft Workflow/ });
  await firstReviewItem.click();
  await page.getByPlaceholder("Explain approval or required changes").fill("Please revise the cartridge metadata.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByText("The submission status was updated.")).toBeVisible();

  await page.goto(`${storeOrigin()}/workspace`);
  const rejectedRow = page.getByRole("listitem").filter({ hasText: "browser-draft" });
  await expect(rejectedRow.getByText("Rejected", { exact: true })).toBeVisible();
  const revise = rejectedRow.getByRole("button", { name: "Revise and resubmit" });
  await revise.click();
  await expect(page.getByRole("status")).toContainText("A revision draft was created.");
  const revisionRow = drafts.locator("li").filter({ hasText: "Revision of #" }).last();
  await revisionRow.locator('input[type="file"]').setInputFiles({ name: "browser-draft-revision.zip", mimeType: "application/zip", buffer: submissionBundle("browser-draft", "Browser Draft Workflow") });
  await expect(revisionRow).toContainText("bundle attached");
  const revisionSubmit = page.waitForResponse((candidate) => candidate.url().includes("/api/drafts/") && candidate.url().endsWith("/submit"));
  await Promise.all([revisionSubmit, revisionRow.getByRole("button", { name: "Submit" }).click()]);
  expect((await revisionSubmit).status()).toBe(200);

  await page.goto(`${storeOrigin()}/review`);
  await page.getByRole("button", { name: /Browser Draft Workflow/ }).click();
  await page.getByPlaceholder("Explain approval or required changes").fill("Approved after revision.");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("The submission status was updated.")).toBeVisible();
  await logoutLocal(page);
});

test("covers administrative read surfaces and generic federation administration", async ({ page }) => {
  await loginLocal(page);
  await page.goto(`${storeOrigin()}/admin`);
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  await expect(page.locator("tbody").getByText("browser-admin", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Roles", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible();
  await expect(page.getByText("publisher", { exact: true })).toBeVisible();
  await page.goto(`${storeOrigin()}/admin/federation/providers`);
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.getByText("Disposable OIDC")).toBeVisible();
  await expect(page.getByText("Disposable SAML")).toBeVisible();
  await logoutLocal(page);
});
