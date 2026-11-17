import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminIntegrationUnavailableError, adminApi, clearAdminSessionState } from "./admin";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("admin API integration", () => {
  beforeEach(() => {
    clearAdminSessionState();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("uses the Fastify API and in-memory CSRF for mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, settings: {}, read_only: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await adminApi.updateSettings({ store_name: "Test Store" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/csrf");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/settings");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: "same-origin", method: "PATCH" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CSRFToken")).toBe("csrf-token-that-is-long-enough-for-the-contract-123");
    expect(localStorage.length).toBe(0);
  });

  it("fails closed when the Fastify API is not configured", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } })));
    await expect(adminApi.getPrincipal()).rejects.toBeInstanceOf(AdminIntegrationUnavailableError);
  });

  it("does not retry destructive requests after a backend rejection", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "catalog operation requires recovery", code: "catalog_recovery_required" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(adminApi.deleteCartridge("demo", "1.0.0", "qemu")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
