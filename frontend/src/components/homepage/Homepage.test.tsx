import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Homepage } from "./Homepage";

describe("Homepage", () => {
  it("presents the project independently from the catalog", () => {
    render(<Homepage />);

    expect(screen.getByRole("heading", { name: /Build cartridges/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /A classroom runtime/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Explore cartridges/i })).toHaveAttribute("href", "/explore");
    expect(screen.getByRole("link", { name: /Start with the project/i })).toHaveAttribute("href", "/docs/getting-started");
    expect(screen.queryByRole("heading", { name: "All cartridges" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search cartridges")).not.toBeInTheDocument();
  });

  it("keeps the participation path usable without catalog data", () => {
    render(<Homepage />);

    expect(screen.getByRole("heading", { name: /Ready to find your next cartridge/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Explore" }))
      .toHaveAttribute("href", "/explore");
    expect(screen.getByRole("link", { name: "Open Explore" }))
      .toHaveClass("homepage-cta-button-primary");
    expect(screen.getByRole("link", { name: /Browse docs/i }))
      .toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: /Browse docs/i }))
      .toHaveClass("homepage-cta-button-secondary");
  });

  it("reveals project specifications when the system map is explored", async () => {
    const user = userEvent.setup();
    render(<Homepage />);

    const map = screen.getByRole("group", { name: "Interactive PRG32 system map" });
    const cartridgeCell = screen.getByRole("button", { name: "Inspect Cartridge format" });

    expect(map).toBeInTheDocument();
    expect(screen.getByText("INIT / UPDATE / DRAW")).toBeInTheDocument();

    await user.hover(cartridgeCell);

    expect(screen.getByText(/A \.prg32 cartridge carries metadata and target binaries/)).toBeInTheDocument();
  });
});
