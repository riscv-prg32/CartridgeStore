"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ApiRequestError } from "../../lib/api/client";
import { getRunDetail, getRuns } from "../../lib/api/metrics";
import { metricsQueryKeys } from "../../lib/api/query-keys";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { StatusMessage } from "../ui/status";

function ErrorState({ error }: { error: unknown }) {
  const message = error instanceof ApiRequestError && error.status === 403 ? "You are not authorized to view these metrics." : "Metrics could not be loaded. Try again later.";
  return <StatusMessage tone="danger" className="p-5">{message}</StatusMessage>;
}

export function MetricsRunsPage() {
  const query = useQuery({ queryKey: metricsQueryKeys.runs(), queryFn: getRuns, retry: false });
  return <ProtectedRoute><main className="mx-auto max-w-6xl px-6 py-10"><header className="mb-8"><p className="text-sm font-semibold uppercase tracking-wide text-violet-700">Private telemetry</p><h1 className="mt-2 text-4xl font-bold">Metrics runs</h1><p className="mt-3 text-[var(--color-text-muted)]">Only runs allowed by the backend owner/admin policy are shown.</p></header>{query.isPending && <p role="status">Loading runs…</p>}{query.error && <ErrorState error={query.error} />}{query.data && query.data.length === 0 && <p className="rounded-md bg-[var(--color-surface-muted)] p-5 text-sm text-[var(--color-text-muted)]">No authorized runs are available.</p>}{query.data && query.data.length > 0 && <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"><table className="w-full min-w-[46rem] text-left text-sm"><caption className="sr-only">Authorized metrics runs</caption><thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]"><tr><th className="px-4 py-3">Run</th><th className="px-4 py-3">Game</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Samples</th><th className="px-4 py-3">Status</th></tr></thead><tbody>{query.data.map((run) => <tr key={run.run_id} className="border-b border-[var(--color-border)] last:border-0"><th scope="row" className="px-4 py-3 font-semibold"><Link className="text-violet-700 hover:underline" href={`/runs/${encodeURIComponent(run.run_id)}`}>{run.run_id}</Link></th><td className="px-4 py-3">{run.game_name}</td><td className="px-4 py-3">{run.target}</td><td className="px-4 py-3">{run.sample_count ?? "—"}</td><td className="px-4 py-3">{run.finished_at === null ? "Active" : "Finished"}</td></tr>)}</tbody></table></div>}</main></ProtectedRoute>;
}

export function MetricsRunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const query = useQuery({ queryKey: metricsQueryKeys.run(runId), queryFn: () => getRunDetail(runId), retry: false });
  return <ProtectedRoute><main className="mx-auto max-w-5xl px-6 py-10"><Link className="text-sm font-semibold text-violet-700 underline" href="/runs">← Back to metrics runs</Link>{query.isPending && <p className="mt-8" role="status">Loading run…</p>}{query.error && <div className="mt-8"><ErrorState error={query.error} /></div>}{query.data && <><header className="mt-6"><p className="text-sm font-semibold uppercase tracking-wide text-violet-700">Metrics run</p><h1 className="mt-2 break-all text-3xl font-bold">{query.data.run.run_id}</h1><p className="mt-2 text-[var(--color-text-muted)]">{query.data.run.game_name} · {query.data.run.target}</p></header><section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["Samples", query.data.summary.sample_count], ["Frame average", `${query.data.summary.frame_us_avg.toFixed(1)} μs`], ["Frame p95", `${query.data.summary.frame_us_p95.toFixed(1)} μs`], ["FPS average", query.data.summary.fps_avg.toFixed(2)]] .map(([label, value]) => <div key={String(label)} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"><p className="text-sm text-[var(--color-text-muted)]">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</section><section className="mt-8 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6"><h2 className="text-xl font-bold">Run metadata</h2><dl className="mt-4 grid gap-3 sm:grid-cols-2">{[["Board", query.data.run.board_id], ["Firmware", query.data.run.firmware_version], ["Git SHA", query.data.run.firmware_git_sha], ["Submitted by", query.data.run.submitted_by], ["Deadline misses", query.data.summary.deadline_missed], ["Finished", query.data.run.finished_at === null ? "Active" : "Yes"]].map(([label, value]) => <div key={String(label)}><dt className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt><dd className="mt-1 break-all text-sm">{value}</dd></div>)}</dl><div className="mt-6 flex flex-wrap gap-3"><a className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--color-surface-muted)]" href={`/api/runs/${encodeURIComponent(runId)}/samples.csv`}>Download CSV</a><a className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-semibold hover:bg-[var(--color-surface-muted)]" href={`/api/runs/${encodeURIComponent(runId)}/report.md`}>Open Markdown report</a></div></section></>}</main></ProtectedRoute>;
}
