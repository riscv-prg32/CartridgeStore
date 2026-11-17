import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { getDownloadStats, getRunStats, getScoreStats } from "../../lib/api/statistics";
import { StatisticsPage } from "./StatisticsPage";

vi.mock("../../lib/api/statistics", () => ({
  getDownloadStats: vi.fn(),
  getRunStats: vi.fn(),
  getScoreStats: vi.fn(),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><StatisticsPage /></QueryClientProvider>);
}

describe("StatisticsPage", () => {
  beforeEach(() => {
    vi.mocked(getDownloadStats).mockReset();
    vi.mocked(getRunStats).mockReset();
    vi.mocked(getScoreStats).mockReset();
  });

  test("renders real aggregates, units, and a textual download alternative", async () => {
    vi.mocked(getDownloadStats).mockResolvedValue({
      total: 12,
      series: [{ date: "2026-10-14", downloads: 12 }],
      top_games: [{ id: "org.example.pong", title: "PRG32 Pong", downloads: 12, last_published: "" }],
    });
    vi.mocked(getScoreStats).mockResolvedValue({ scores: [{ game: "pong", player: "Ada", score: 42, created_at: 1_760_000_000, submitted_by: "Ada" }] });
    vi.mocked(getRunStats).mockResolvedValue({ total: 3, finished: 2, active_last_7_days: 1 });

    renderPage();

    expect(await screen.findByText("Download activity")).toBeInTheDocument();
    expect(await screen.findAllByText("12")).not.toHaveLength(0);
    expect(screen.getByText("2026-10-14")).toBeInTheDocument();
    expect(screen.getByText("PRG32 Pong")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Download events by period" })).toBeInTheDocument();
    expect(screen.queryByText("Microseconds")).not.toBeInTheDocument();
  });

  test("shows explicit empty states without inventing values", async () => {
    vi.mocked(getDownloadStats).mockResolvedValue({ total: 0, series: [], top_games: [] });
    vi.mocked(getScoreStats).mockResolvedValue({ scores: [] });
    vi.mocked(getRunStats).mockResolvedValue({ total: 0, finished: 0, active_last_7_days: 0 });

    renderPage();

    expect(await screen.findByText("No download events are available for the selected period.")).toBeInTheDocument();
    expect(screen.getByText("No downloaded cartridges are recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No scores are available yet.")).toBeInTheDocument();
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  test("does not hide API failures behind fallback statistics", async () => {
    vi.mocked(getDownloadStats).mockRejectedValue(new Error("network down"));
    vi.mocked(getScoreStats).mockRejectedValue(new Error("network down"));
    vi.mocked(getRunStats).mockRejectedValue(new Error("network down"));

    renderPage();

    expect(await screen.findAllByRole("alert")).toHaveLength(3);
    expect(screen.queryByText("12")).not.toBeInTheDocument();
  });
});
