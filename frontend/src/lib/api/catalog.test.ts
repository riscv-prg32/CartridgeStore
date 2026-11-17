import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  catalogDownloadPath,
  catalogMediaPath,
  getCatalog,
  preferredCatalogArchitecture,
} from "./catalog";

describe("catalog compatibility routing", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  test("keeps catalog pagination on the Next same-origin rewrite", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      games: [],
      pagination: {
        page: 1,
        per_page: 100,
        total: 0,
        pages: 1,
        has_next: false,
        has_prev: false,
        next_page: null,
        prev_page: null,
      },
    }), { status: 200 }));

    await getCatalog({ page: 1, perPage: 100 });

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/games?page=1&per_page=100");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  test("keeps binary download URLs on the canonical API route", () => {
    expect(
      catalogDownloadPath("org.example.pong", "1.0.0", "qemu"),
    ).toBe(
      "/api/games/org.example.pong/download?version=1.0.0&architecture=qemu",
    );
  });

  test("keeps cartridge media URLs on the canonical API route", () => {
    expect(catalogMediaPath("org.example.pong", "icon", "1.0.0")).toBe(
      "/api/games/org.example.pong/icon?version=1.0.0",
    );
  });

  test("prefers the physical target regardless of API list ordering", () => {
    expect(preferredCatalogArchitecture(["qemu", "esp32c6"])).toBe("esp32c6");
    expect(preferredCatalogArchitecture(["qemu"])).toBe("qemu");
    expect(preferredCatalogArchitecture([])).toBeUndefined();
  });
});
