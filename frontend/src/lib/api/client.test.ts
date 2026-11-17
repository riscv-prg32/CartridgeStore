import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ApiResponseValidationError, requestJson, requestSameOriginJson } from "./client";
import { discoveryDocumentSchema } from "./schemas";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("uses same-origin credentials for API requests", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  await expect(requestJson<{ ok: true }>("/api/games")).resolves.toEqual({ ok: true });
  const call = vi.mocked(fetch).mock.calls[0];
  expect(call).toBeDefined();
  const init = call?.[1];
  expect(init).toEqual(expect.objectContaining({ credentials: "same-origin" }));
  expect((init?.headers as Headers).get("Accept")).toBe("application/json");
});

test("keeps operational public requests on the same-origin compatibility boundary", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  await requestSameOriginJson<{ ok: true }>("/api/games?page=1&per_page=100");
  const call = vi.mocked(fetch).mock.calls[0];
  expect(call?.[0]).toBe("/api/games?page=1&per_page=100");
  expect(call?.[1]).toEqual(expect.objectContaining({ credentials: "same-origin" }));
});

test("merges caller headers without dropping the JSON accept header", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  await requestJson("/api/games", { headers: { "X-PRG32-Token": "synthetic" } });
  const call = vi.mocked(fetch).mock.calls[0];
  expect(call).toBeDefined();
  const init = call?.[1];
  const headers = init?.headers as Headers;
  expect(headers.get("Accept")).toBe("application/json");
  expect(headers.get("X-PRG32-Token")).toBe("synthetic");
});

test("validates known API responses at runtime", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ abi: "not-an-abi" }), { status: 200 }),
  );

  await expect(requestJson("/.well-known/prg32-store.json", undefined, discoveryDocumentSchema)).rejects.toBeInstanceOf(
    ApiResponseValidationError,
  );
});

test("normalizes API errors without exposing response internals", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401 }),
  );

  await expect(requestJson("/api/private")).rejects.toMatchObject({
    name: "ApiRequestError",
    status: 401,
    message: "Unauthorized",
  });
});
