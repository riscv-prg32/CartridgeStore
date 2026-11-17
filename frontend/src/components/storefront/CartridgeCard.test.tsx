import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import type { Game } from "../../lib/api/contracts";
import { CartridgeCard } from "./CartridgeCard";

const game: Game = {
  id: "org.example.pong",
  title: "PRG32 Pong",
  summary: "A synthetic cartridge.",
  authors: [{ name: "PRG32 Lab" }],
  tags: ["arcade"],
  latest_version: "1.0.0",
  selected_version: "1.0.0",
  versions: ["1.0.0"],
  architectures: ["qemu", "esp32c6"],
  metadata: null,
  colophon: null,
  variants: {},
  publisher: "PRG32 Lab",
  updated_at: null,
};

describe("CartridgeCard", () => {
  test("preserves catalog identity and download compatibility", () => {
    render(<CartridgeCard game={game} />);

    expect(screen.getByRole("link", { name: "Open PRG32 Pong" })).toHaveAttribute("href", "/games/org.example.pong");
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/api/games/org.example.pong/download?version=1.0.0&architecture=esp32c6",
    );
    expect(screen.getByText("qemu")).toBeInTheDocument();
    expect(screen.getByText("esp32c6")).toBeInTheDocument();
  });
});
