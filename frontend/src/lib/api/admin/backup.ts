import type { AdminResponse } from "./types";
import {
  adminRequest,
  backupRequest,
  clearAdminSessionState,
  mutationHeaders,
} from "./transport";

function backupFilename(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  return (
    disposition.match(/filename=([^;]+)/i)?.[1]?.replace(/^"|"$/g, "") ??
    "prg32-backup.bin"
  );
}
/** Downloads an encrypted administrative backup. */
export async function downloadAdminBackup(
  password?: string,
): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  if (password) {
    headers.set("X-PRG32-Backup-Password", password);
  }
  const response = await backupRequest("/admin/backup/download", { headers });
  return {
    blob: await response.blob(),
    filename: backupFilename(response),
  };
}

/** Restores an administrative backup and clears cached session state. */
export async function restoreAdminBackup(
  file: File,
  password?: string,
): Promise<AdminResponse<Record<string, unknown>>> {
  const headers = await mutationHeaders();
  if (password) {
    headers.set("X-PRG32-Backup-Password", password);
  }
  const body = new FormData();
  body.append("backup", file);
  const response = await adminRequest<AdminResponse<Record<string, unknown>>>(
    "/admin/backup/restore",
    {
      method: "POST",
      headers,
      body,
    },
  );
  clearAdminSessionState();
  return response;
}
