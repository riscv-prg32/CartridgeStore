import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { getScores } from "../../lib/api/scores";
import { getCatalog } from "../../lib/api/catalog";
import type { ScoreRecord } from "../../lib/api/contracts";
import { Scoreboard } from "./Scoreboard";

const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/scores",
  useSearchParams: () => navigation.searchParams,
}));

vi.mock("../../lib/api/scores", () => ({ getScores: vi.fn() }));
vi.mock("../../lib/api/catalog", () => ({ getCatalog: vi.fn() }));

const score = (overrides: Partial<ScoreRecord> = {}): ScoreRecord => ({ game: "pong", player: "Ada", score: 42, created_at: 1_760_000_000, submitted_by: "Ada", ...overrides });

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Scoreboard /></QueryClientProvider>);
}

describe("Scoreboard", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/scores");
    navigation.searchParams = new URLSearchParams();
    vi.mocked(getScores).mockReset();
    vi.mocked(getCatalog).mockResolvedValue({ games: [], ok: true, pagination: { page: 1, per_page: 100, total: 0, pages: 1, has_next: false, has_prev: false, next_page: null, prev_page: null } });
  });

  test("renders backend ordering without inventing identity or tie rules", async () => {
    vi.mocked(getScores).mockResolvedValue([score(), score({ player: "Grace", score: 1200, created_at: 1_760_000_001 })]);
    renderPage();

    expect(await screen.findByRole("heading", { name: "Scores in this view" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1,200" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "PRG32 scoreboard results" })).toBeInTheDocument();
    expect(screen.queryByText("Global rank")).not.toBeInTheDocument();
    expect(getScores).toHaveBeenCalledWith({ game: "", player: "", limit: 20 });
  });

  test("applies supported game, player and bounded row filters", async () => {
    const user = userEvent.setup();
    vi.mocked(getScores).mockResolvedValue([score()]);
    renderPage();

    await user.type(await screen.findByRole("combobox", { name: "Game" }), "pong");
    await user.type(screen.getByLabelText("Filter scores by player"), "Ada");
    await user.click(screen.getByRole("combobox", { name: "Rows" }));
    await user.click(await screen.findByRole("option", { name: "50" }));
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(window.location.pathname).toBe("/scores");
    expect(window.location.search).toBe("?game=pong&player=Ada&limit=50");
  });

  test("renders empty and failure states", async () => {
    vi.mocked(getScores).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No scores match these filters.")).toBeInTheDocument();

    vi.mocked(getScores).mockRejectedValueOnce(new Error("unavailable"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("scoreboard could not be loaded");
  });
});
