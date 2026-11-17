import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ApiRequestError } from "../../lib/api/client";
import { getGame } from "../../lib/api/catalog";
import type { Game } from "../../lib/api/contracts";
import { GameDetail } from "./GameDetail";

const navigation = vi.hoisted(() => ({ push: vi.fn(), searchParams: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.searchParams,
  useParams: () => ({ gameId: "org.example.pong" }),
}));

vi.mock("../../lib/api/catalog", () => ({
  getGame: vi.fn(),
  catalogMediaPath: (id: string, kind: string, version: string) =>
    `/api/games/${id}/${kind}?version=${version}`,
  catalogDownloadPath: (id: string, version: string, architecture: string) =>
    `/api/games/${id}/download?version=${version}&architecture=${architecture}`,
  preferredCatalogArchitecture: (architectures: readonly string[]) =>
    architectures.includes("esp32c6") ? "esp32c6" : architectures[0],
}));

const detail: Game = {
  id: "org.example.pong",
  title: "PRG32 Pong",
  summary: "A synthetic cartridge for detail tests.",
  authors: [{ name: "PRG32 Lab" }],
  tags: ["arcade"],
  latest_version: "1.0.0",
  selected_version: "1.0.0",
  versions: ["1.0.0", "0.9.0"],
  architectures: ["qemu", "esp32c6"],
  metadata: { abi: "prg32-metadata-1.0", genre: "arcade" },
  colophon: {
    abi: "prg32-colophon-1.0",
    controls: [
      { input: "D-Pad", action: "Move" },
      { input: "A", action: "Add score / beep" },
    ],
    developer: { name: "PRG32 Lab" },
  },
  variants: {
    qemu: { size: 2048, has_screenshot: false },
    esp32c6: { size: 3072, has_screenshot: false },
  },
  publisher: "PRG32 Lab",
  updated_at: "2026-10-13T00:00:00Z",
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><GameDetail /></QueryClientProvider>);
}

describe("GameDetail", () => {
  beforeEach(() => {
    navigation.push.mockReset();
    navigation.searchParams = new URLSearchParams();
    vi.mocked(getGame).mockReset();
  });

  test("renders metadata, version/architecture selection, and the compatible download URL", async () => {
    const user = userEvent.setup();
    vi.mocked(getGame).mockResolvedValue({ ok: true, game: detail });
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "PRG32 Pong" }),
    ).toBeInTheDocument();
    expect(screen.getByText("arcade")).toBeInTheDocument();
    expect(screen.getByText("genre")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Controls" })).toBeInTheDocument();
    expect(screen.getByText("D-Pad")).toBeInTheDocument();
    expect(screen.getByText("Add score / beep")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download esp32c6" })).toHaveAttribute(
      "href",
      "/api/games/org.example.pong/download?version=1.0.0&architecture=esp32c6",
    );

    await user.click(screen.getByRole("combobox", { name: "Architecture" }));
    await user.click(await screen.findByRole("option", { name: "qemu" }));
    expect(screen.getByRole("link", { name: "Download qemu" })).toHaveAttribute(
      "href",
      "/api/games/org.example.pong/download?version=1.0.0&architecture=qemu",
    );
    await user.click(screen.getByRole("combobox", { name: "Version" }));
    await user.click(await screen.findByRole("option", { name: "0.9.0" }));
    expect(navigation.push).toHaveBeenCalledWith("/games/org.example.pong?version=0.9.0");
  });

  test("renders a protected/missing cartridge without leaking API details", async () => {
    vi.mocked(getGame).mockRejectedValue(new ApiRequestError("not found", 404, { ok: false, error: "game not found" }));
    renderDetail();
    expect(await screen.findByText("Cartridge not found")).toBeInTheDocument();
    expect(screen.queryByText("not found")).not.toBeInTheDocument();
  });
});
