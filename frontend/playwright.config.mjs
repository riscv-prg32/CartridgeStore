import { defineConfig } from "@playwright/test";

const baseURL = process.env.PRG32_E2E_BASE_URL?.trim() || "http://127.0.0.1:3100";
const legacyDisposable = process.env.PRG32_E2E_LEGACY_DISPOSABLE === "1";
const fullstackDisposable = process.env.PRG32_E2E_FULLSTACK === "1";
const authenticatedDisposable = process.env.PRG32_E2E_AUTH_DISPOSABLE === "1";
const configuredWebServer = process.env.PRG32_E2E_WEB_SERVER?.trim();
const legacyBaseURL = process.env.PRG32_M52G14_STORE_ORIGIN?.trim() || "https://store.m52g14.test";

export default defineConfig({
  testDir: "./e2e",
  ...(legacyDisposable ? {
    globalSetup: "./e2e/global-setup.mjs",
    globalTeardown: "./e2e/global-teardown.mjs",
  } : {}),
  ...(configuredWebServer && !legacyDisposable ? {
    webServer: {
      command: configuredWebServer,
      url: baseURL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  } : {}),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [["line"]],
  projects: [
    {
      name: "public-smoke",
      testMatch: /public-(smoke|acceptance)\.spec\.mjs/,
      use: {
        baseURL,
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    },
    ...(fullstackDisposable ? [{
      name: "fullstack-disposable",
      testMatch: /fullstack-disposable\.spec\.mjs/,
      use: {
        baseURL,
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    }] : []),
    ...(authenticatedDisposable ? [{
      name: "authenticated-disposable",
      testMatch: /authenticated-(disposable|security-completion)\.spec\.mjs/,
      use: {
        baseURL,
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    }] : []),
    ...(legacyDisposable ? [{
      name: "legacy-disposable",
      testIgnore: /public-(smoke|acceptance)\.spec\.mjs/,
      use: {
        baseURL: legacyBaseURL,
        browserName: "chromium",
        ignoreHTTPSErrors: true,
        launchOptions: {
          args: [
            "--no-proxy-server",
            "--host-resolver-rules=MAP store.m52g14.test 127.0.0.1,MAP api.m52g14.test 127.0.0.1,MAP evil.m52g14.test 127.0.0.1,MAP host.docker.internal 127.0.0.1"
          ]
        }
      }
    }] : []),
  ],
});
