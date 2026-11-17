"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { adminApi, clearAdminSessionState } from "../../../lib/api/admin";
import { Button } from "../../ui/button";
import { Field, Notice, Panel } from "../admin-ui";

export function BackupPanel() {
  const [downloadPassword, setDownloadPassword] = useState("");
  const [restorePassword, setRestorePassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const download = useMutation({ mutationFn: () => adminApi.downloadBackup(downloadPassword || undefined), onSuccess: ({ blob, filename }) => { const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); setMessage("Backup downloaded."); } });
  const restore = useMutation({ mutationFn: () => { if (!file) throw new Error("Select a backup file first."); return adminApi.restoreBackup(file, restorePassword || undefined); }, onSuccess: () => { clearAdminSessionState(); setMessage("Restore completed. Authenticate again before continuing."); } });
  return <Panel title="Backup and restore"><Notice error={download.error ?? restore.error} success={message} /><div className="grid gap-5 md:grid-cols-2"><div className="space-y-3 rounded-md border border-[var(--color-border)] p-4"><h3 className="font-semibold">Download</h3><Field label="Optional backup password" type="password" value={downloadPassword} onChange={(event) => setDownloadPassword(event.target.value)} /><Button disabled={download.isPending} onClick={() => download.mutate()}>{download.isPending ? "Preparing…" : "Download backup"}</Button></div><div className="space-y-3 rounded-md border border-[var(--color-border)] p-4"><h3 className="font-semibold">Restore</h3><input aria-label="backup file" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Field label="Optional backup password" type="password" value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} /><Button variant="danger" disabled={!file || restore.isPending} onClick={() => { if (window.confirm("Restore this backup? The current admin session will be invalidated.")) restore.mutate(); }}>{restore.isPending ? "Restoring…" : "Restore backup"}</Button></div></div></Panel>;
}
