import { expect, test } from "@playwright/test";

const storeOrigin = () => process.env.PRG32_M52G14_STORE_ORIGIN;
const apiOrigin = () => process.env.PRG32_M52G14_API_ORIGIN;
const evilOrigin = () => process.env.PRG32_M52G14_EVIL_ORIGIN;

async function loginLocal(page) {
  await page.goto(`${storeOrigin()}/login`);
  await expect(page.getByRole("link", { name: /Disposable OIDC/ })).toBeVisible();
  await page.getByLabel("Username or email").fill("browser-admin");
  await page.getByLabel("Password").fill("browser-fixture-password-2026");
  const loginResponse = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return (pathname.endsWith("/auth/login") || pathname.endsWith("/api/auth/login")) && response.request().method() === "POST";
  });
  await Promise.all([loginResponse, page.getByRole("button", { name: "Sign in", exact: true }).click()]);
  const loginResult = await loginResponse;
  expect(loginResult.status()).toBe(200);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
}

async function logoutLocal(page) {
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
}

function waitForSocketMessage(page, type) {
  return page.evaluate((expected) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for WebSocket ${expected}`)), 5_000);
    const consume = () => {
      const messages = window.__m52Messages ?? [];
      const index = messages.findIndex((item) => item?.type === expected);
      if (index < 0) return false;
      const [message] = messages.splice(index, 1);
      clearTimeout(deadline);
      resolve(message);
      return true;
    };
    if (consume()) return;
    window.__m52Resolvers ??= {};
    window.__m52Resolvers[expected] ??= [];
    window.__m52Resolvers[expected].push(consume);
  }), type);
}

async function openSocket(page, token, room = "browser-room", expected = "welcome") {
  const url = `${apiOrigin().replace(/^https:/, "wss:")}/api/multiplayer?token=${encodeURIComponent(token)}`;
  await page.evaluate((socketUrl) => {
    window.__m52Messages = [];
    window.__m52Resolvers = {};
    const socket = new WebSocket(socketUrl);
    window.__m52Socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      window.__m52Messages.push(message);
      for (const resolver of window.__m52Resolvers?.[message.type] ?? []) resolver();
    };
  }, url);
  await page.evaluate((roomName) => new Promise((resolve, reject) => {
    const socket = window.__m52Socket;
    const deadline = setTimeout(() => reject(new Error("WebSocket did not open")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(deadline);
      socket.send(JSON.stringify({ type: "join", signature: roomName, player_id: 1 }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket connection failed (readyState=${socket.readyState})`)), { once: true });
    socket.addEventListener("close", (event) => reject(new Error(`WebSocket closed before open (code=${event.code}, reason=${event.reason})`)), { once: true });
  }), room);
  return waitForSocketMessage(page, expected);
}

test("browses the canonical catalog, detail media, architecture and download journey", async ({ page }) => {
  const response = await page.goto(`${storeOrigin()}/`);
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Play. Code. Learn." })).toBeVisible();
  await expect(page.getByText("Browser Fixture")).toBeVisible();
  await page.getByLabel("Search cartridges").fill("Browser Fixture");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=Browser%20Fixture|q=Browser\+Fixture/);
  await page.getByRole("link", { name: /Browser Fixture/ }).click();
  await expect(page.getByRole("heading", { name: "Browser Fixture" })).toBeVisible();
  await expect(page.getByAltText("Browser Fixture icon")).toBeVisible();
  await expect(page.getByAltText("Browser Fixture screenshot")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select architecture qemu" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download qemu" }).click();
  expect((await download).suggestedFilename()).toContain("browser-fixture");
});

test("authenticates locally, enforces CSRF, preserves cookie boundaries and logs out", async ({ browser, context, page }) => {
  await loginLocal(page);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await page.getByLabel("Label").fill("browser-e2e-token");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("New token:")).toBeVisible();

  const missingCsrf = await page.evaluate(async () => {
    const response = await fetch("/api/auth/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "must-fail" }) });
    return { status: response.status, body: await response.json() };
  });
  expect(missingCsrf.status).toBe(403);
  expect(missingCsrf.body.code).toBe("csrf_failed");

  const sessionCookie = (await context.cookies()).find((cookie) => cookie.name === "prg32_ts_session");
  expect(sessionCookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
  expect([new URL(storeOrigin()).hostname, ".m52g14.test"]).toContain(sessionCookie.domain);

  await logoutLocal(page);
  const legacyContext = await browser.newContext();
  await legacyContext.addCookies([{ name: "session", value: "legacy-cookie-does-not-authenticate", domain: new URL(storeOrigin()).hostname, path: "/" }]);
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(`${storeOrigin()}/`);
  const legacyResponse = await legacyPage.evaluate(async () => {
    const response = await fetch("/api/me");
    return response.status;
  });
  expect(legacyResponse).toBe(401);
  await legacyPage.close();
  await legacyContext.close();
});

test("keeps direct API CORS exact and uses the same-origin Next proxy", async ({ page, context }) => {
  await page.goto(`${storeOrigin()}/`);
  const sameOriginRequests = [];
  page.on("request", (request) => { if (request.url().includes("/api/games")) sameOriginRequests.push(request.url()); });
  await page.reload();
  await expect(page.getByText("Browser Fixture")).toBeVisible();
  expect(sameOriginRequests.some((url) => url.startsWith(`${storeOrigin()}/api/`))).toBe(true);

  const directResponsePromise = page.waitForResponse((response) => response.url() === `${apiOrigin()}/api/games` && response.request().method() === "GET");
  const allowed = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/api/games`, { credentials: "include" });
    return { status: response.status };
  }, apiOrigin());
  const directResponse = await directResponsePromise;
  expect(allowed.status).toBe(200);
  expect(directResponse.headers()).toMatchObject({ "access-control-allow-origin": storeOrigin(), "access-control-allow-credentials": "true" });

  const preflighted = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/auth/tokens`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrftoken": "invalid" }, body: "{}" });
    return { status: response.status };
  }, apiOrigin());
  expect(preflighted.status).toBe(401);

  const evil = await context.newPage();
  await evil.goto(`${evilOrigin()}/`);
  const denied = await evil.evaluate(async (url) => {
    try {
      await fetch(`${url}/api/games`, { credentials: "include" });
      return false;
    } catch {
      return true;
    }
  }, apiOrigin());
  expect(denied).toBe(true);
  await evil.close();
});

test("completes synthetic OIDC and SAML browser callbacks", async ({ page }) => {
  await page.goto(`${storeOrigin()}/login`);
  await page.getByRole("link", { name: /Disposable OIDC/ }).click();
  await expect(page).toHaveURL(`${storeOrigin()}/`);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByText("federated-browser")).toBeVisible();
  await logoutLocal(page);

  await page.goto(`${storeOrigin()}/login`);
  await page.getByRole("link", { name: /Disposable SAML/ }).click();
  await expect(page).toHaveURL(`${storeOrigin()}/`);
  await page.goto(`${storeOrigin()}/dashboard/account`);
  await expect(page.getByText("federated-saml-browser")).toBeVisible();
  await logoutLocal(page);
});

test("exercises authenticated WSS join, relay, invalid token rejection and room limit", async ({ browser, context, page }) => {
  await loginLocal(page);
  const token = await page.evaluate(async () => {
    const csrf = await fetch("/api/auth/csrf");
    const csrfToken = (await csrf.json()).csrf_token;
    const response = await fetch("/api/auth/tokens", { method: "POST", headers: { "x-csrftoken": csrfToken, "content-type": "application/json" }, body: JSON.stringify({ label: "wss-browser" }) });
    return (await response.json()).token;
  });
  expect(token).toMatch(/^prg32_/);

  const peerPage = await context.newPage();
  await peerPage.goto(`${storeOrigin()}/`);
  const firstWelcome = await openSocket(page, token);
  expect(firstWelcome.type).toBe("welcome");
  const secondWelcome = await openSocket(peerPage, token);
  expect(secondWelcome.type).toBe("welcome");
  const peerMessage = waitForSocketMessage(peerPage, "peer");
  await page.evaluate(() => window.__m52Socket.send(JSON.stringify({ type: "state", x: 12, y: 8, frame: 4 })));
  expect(await peerMessage).toMatchObject({ type: "peer", x: 12, y: 8, frame: 4 });

  const invalidPage = await context.newPage();
  await invalidPage.goto(`${storeOrigin()}/`);
  const invalidWelcome = await openSocket(invalidPage, "invalid-token", "invalid-room", "error");
  expect(invalidWelcome).toMatchObject({ type: "error", error: "player role required" });
  const fullPage = await context.newPage();
  await fullPage.goto(`${storeOrigin()}/`);
  const fullMessage = await openSocket(fullPage, token, "browser-room", "error");
  expect(fullMessage).toMatchObject({ type: "error", error: "game room is full" });

  await page.evaluate(() => window.__m52Socket.close());
  await peerPage.evaluate(() => window.__m52Socket.close());
  await invalidPage.evaluate(() => window.__m52Socket.close());
  await fullPage.evaluate(() => window.__m52Socket.close());
  await Promise.all([peerPage.close(), invalidPage.close(), fullPage.close()]);
  await logoutLocal(page);
});
