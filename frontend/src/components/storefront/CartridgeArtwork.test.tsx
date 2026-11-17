import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { CartridgeArtwork } from "./CartridgeArtwork";

describe("CartridgeArtwork", () => {
  test("fails closed to an explicit fallback when media is unavailable", () => {
    render(<CartridgeArtwork gameId="org.example.pong" version="1.0.0" kind="icon" alt="Pong artwork" />);

    fireEvent.error(screen.getByRole("img", { name: "Pong artwork" }));

    expect(screen.getByText("Artwork unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pong artwork" })).not.toBeInTheDocument();
  });
});
