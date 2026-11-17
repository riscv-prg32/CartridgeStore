import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "./SiteFooter";

describe("SiteFooter", () => {
  it("communicates the project identity and institutional attribution", () => {
    render(<SiteFooter />);

    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent("PRG32");
    expect(footer).toHaveTextContent("Cartridge Store is part of the PRG32 project ecosystem.");
    expect(footer).toHaveTextContent("Università degli Studi di Napoli Parthenope");
    expect(footer).toHaveTextContent("Open source · MIT License");
  });

  it("restores separated explore and project navigation links", () => {
    render(<SiteFooter />);

    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("heading", { name: "EXPLORE" })).toBeInTheDocument();
    expect(within(footer).getByRole("heading", { name: "PROJECT" })).toBeInTheDocument();

    const explore = within(footer).getByRole("navigation", { name: "Explore footer links" });
    expect(within(explore).getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    expect(within(explore).getByRole("link", { name: "Leaderboards" })).toHaveAttribute("href", "/scores");
    expect(within(explore).getByRole("link", { name: "Statistics" })).toHaveAttribute("href", "/stats");

    const project = within(footer).getByRole("navigation", { name: "Project footer links" });
    expect(within(project).getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs");
    const repository = within(project).getByRole("link", { name: /GitHub/ });
    expect(repository).toHaveAttribute("href", "https://github.com/riscv-prg32/PRG32");
    expect(repository).toHaveAttribute("target", "_blank");
    expect(repository).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("keeps every footer link as a distinct keyboard-reachable element", () => {
    render(<SiteFooter />);

    const footer = screen.getByRole("contentinfo");
    const links = within(footer).getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(new Set(links.map((link) => link.textContent?.trim())).size).toBe(5);
  });
});
