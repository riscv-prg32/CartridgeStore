"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import { ApiRequestError } from "../../lib/api/client";
import { getUserProfile, getUserRun, getUserRuns } from "../../lib/api/profile";
import { profileQueryKeys } from "../../lib/api/query-keys";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { StatusMessage } from "../ui/status";

function ErrorState({ error }: { error: unknown }) {
  const status = error instanceof ApiRequestError ? error.status : 0;
  return <StatusMessage tone="danger" className="p-5">{status === 403 ? "You are not authorized to view this private data." : status === 404 ? "The requested user or run was not found." : "The profile service could not be reached."}</StatusMessage>;
}

export function ProfilePage() {
  const params = useParams<{ username: string }>();
  const username = params.username;
  const profile = useQuery({ queryKey: profileQueryKeys.user(username), queryFn: () => getUserProfile(username), retry: false });
  return <main className="page-gutter py-8 sm:py-10"><div className="page-reading">{profile.isPending && <p className="surface-card p-5" role="status">Loading profile…</p>}{profile.error && <ErrorState error={profile.error} />}{profile.data && <><header className="border-b border-[var(--color-border)] pb-6"><p className="technical-label text-[var(--color-primary)]">Account profile</p><h1 className="mt-2 text-4xl font-bold">{profile.data.user.username}</h1><p className="mt-3 text-sm text-[var(--color-text-muted)]">Role: {profile.data.user.role} · Runs: {profile.data.run_count}</p>{profile.data.can_view_runs && <Link className="mt-6 inline-flex rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white" href={`/users/${encodeURIComponent(username)}/runs`}>View runs</Link>}</header></>}</div></main>;
}

export function ProfileRunsPage() {
  const params = useParams<{ username: string }>();
  const username = params.username;
  const runs = useQuery({ queryKey: profileQueryKeys.runs(username), queryFn: () => getUserRuns(username), retry: false });
  return <ProtectedRoute><main className="page-gutter py-8 sm:py-10"><div className="page-reading"><Link className="text-sm font-semibold text-[var(--color-primary-strong)] underline" href={`/users/${encodeURIComponent(username)}`}>← Back to profile</Link><h1 className="mt-6 text-4xl font-bold">{username} runs</h1>{runs.isPending && <p className="mt-8 surface-card p-5" role="status">Loading runs…</p>}{runs.error && <div className="mt-8"><ErrorState error={runs.error} /></div>}{runs.data && runs.data.runs.length === 0 && <p className="mt-8 rounded-md bg-[var(--color-surface-muted)] p-5 text-sm">No runs yet.</p>}{runs.data && runs.data.runs.length > 0 && <div className="mt-8 overflow-x-auto rounded-md border border-[var(--color-border)]"><table className="w-full min-w-[48rem] text-left text-sm"><thead className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-text-muted)]"><tr><th className="px-4 py-3">Run ID</th><th className="px-4 py-3">Board</th><th className="px-4 py-3">Target</th><th className="px-4 py-3">Frames</th><th className="px-4 py-3">Mean μs</th><th className="px-4 py-3">p95 μs</th><th className="px-4 py-3">Finished</th></tr></thead><tbody>{runs.data.runs.map((run) => <tr key={run.run_id} className="border-b border-[var(--color-border)] last:border-0"><th className="px-4 py-3 font-semibold" scope="row"><Link className="text-[var(--color-primary-strong)] hover:underline" href={`/users/${encodeURIComponent(username)}/runs/${encodeURIComponent(run.run_id)}`}>{run.run_id}</Link></th><td className="px-4 py-3">{run.board_id}</td><td className="px-4 py-3">{run.target}</td><td className="px-4 py-3">{run.sample_count ?? 0}</td><td className="px-4 py-3">{run.mean_frame_us.toFixed(1)}</td><td className="px-4 py-3">{run.p95_frame_us.toFixed(1)}</td><td className="px-4 py-3">{run.finished_at ?? "Active"}</td></tr>)}</tbody></table></div>}</div></main></ProtectedRoute>;
}

export function ProfileRunDetailPage() {
  const params = useParams<{ username: string; runId: string }>();
  const detail = useQuery({ queryKey: profileQueryKeys.run(params.username, params.runId), queryFn: () => getUserRun(params.username, params.runId), retry: false });
  return <ProtectedRoute><main className="page-gutter py-8 sm:py-10"><div className="page-reading"><Link className="text-sm font-semibold text-[var(--color-primary-strong)] underline" href={`/users/${encodeURIComponent(params.username)}/runs`}>← Back to runs</Link>{detail.isPending && <p className="mt-8 surface-card p-5" role="status">Loading run…</p>}{detail.error && <div className="mt-8"><ErrorState error={detail.error} /></div>}{detail.data && <><h1 className="mt-6 break-all text-3xl font-bold">{detail.data.run.run_id}</h1><p className="mt-2 text-sm text-[var(--color-text-muted)]">{detail.data.run.game_name} · {detail.data.run.target}</p><div className="mt-8 grid gap-3 sm:grid-cols-3">{[["Samples", detail.data.summary.sample_count], ["Mean frame μs", detail.data.summary.frame_us_avg.toFixed(1)], ["p95 frame μs", detail.data.summary.frame_us_p95.toFixed(1)]].map(([label, value]) => <div key={String(label)} className="surface-card p-5"><p className="text-sm text-[var(--color-text-muted)]">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>)}</div><div className="mt-8 flex flex-wrap gap-3"><a className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-semibold" href={`/api/runs/${encodeURIComponent(params.runId)}?format=json`}>Download JSON</a><a className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-semibold" href={`/api/runs/${encodeURIComponent(params.runId)}/samples.csv`}>Download CSV</a></div></>}</div></main></ProtectedRoute>;
}
