import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { federatedLoginUrl, getAuthProviders, loginWithPassword, logoutLocal } from "./auth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const principal = {
  id: 7,
  name: "Ada Lovelace",
  username: "ada",
  email: "ada@example.test",
  role: "user",
  groups: [],
  authenticated: true,
  permissions: [],
};

describe("authentication API client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  test("lists providers through the canonical namespace", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true, providers: [{ provider_id: "campus", protocol: "oidc", display_name: "Campus", enabled: true }] }));

    await expect(getAuthProviders()).resolves.toMatchObject({ providers: [{ provider_id: "campus" }] });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/auth/providers");
  });

  test("acquires CSRF before local login and never writes a password to browser storage", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, user: principal }));

    await loginWithPassword("ada", "correct horse battery staple");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/csrf");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/auth/login");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CSRFToken")).toContain("csrf-token");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ username: "ada", password: "correct horse battery staple" });
    expect(localStorage.length).toBe(0);
  });

  test("uses CSRF and the POST contract for local logout", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await logoutLocal();

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/auth/logout");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
  });

  test("builds provider-neutral browser navigation URLs and sanitizes return paths", () => {
    expect(federatedLoginUrl({ provider_id: "campus/main", protocol: "oidc", display_name: "Campus", enabled: true }, "//evil.example")).toBe("/api/auth/oidc/campus%2Fmain/login?return_to=%2F");
    expect(federatedLoginUrl({ provider_id: "university", protocol: "saml", display_name: "University", enabled: true }, "/dashboard/account")).toBe("/api/auth/saml/university/login?return_to=%2Fdashboard%2Faccount");
  });
});
