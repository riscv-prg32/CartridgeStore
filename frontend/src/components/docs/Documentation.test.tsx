import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DocumentationArticle } from "./DocumentationArticle";
import { DocumentationIndex } from "./DocumentationIndex";
import { getDocumentationArticle } from "../../lib/docs/content";

describe("developer documentation", () => {
  test("renders the navigable index and all curated sections", () => {
    render(<DocumentationIndex />);
    expect(screen.getByRole("heading", { name: "Build for PRG32" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Cartridge format/ })).toHaveAttribute("href", "/docs/cartridge-format");
    expect(screen.getByRole("link", { name: /Metrics and runs/ })).toHaveAttribute("href", "/docs/metrics");
  });

  test("renders source-derived article content, tables, code and internal links", () => {
    const article = getDocumentationArticle("scores");
    if (!article) throw new Error("fixture article missing");
    render(<DocumentationArticle article={article} />);
    expect(screen.getByRole("heading", { name: "Scores" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("GET /api/scores?game=pong&player=Ada&limit=20")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open scoreboard/ })).toHaveAttribute("href", "/scores");
    expect(screen.getByText(/Source:/)).toBeInTheDocument();
  });

  test("keeps technical units explicit in metrics documentation", () => {
    const article = getDocumentationArticle("metrics");
    if (!article) throw new Error("fixture article missing");
    render(<DocumentationArticle article={article} />);
    expect(screen.getByText("Microseconds of frame work")).toBeInTheDocument();
    expect(screen.getByText("FPS multiplied by 100 in raw samples")).toBeInTheDocument();
  });
});
