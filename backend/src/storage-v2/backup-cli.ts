import { createCanonicalBackup, CANONICAL_BACKUP_AUTHORIZATION, restoreCanonicalBackup, verifyCanonicalBackup } from "./backup.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required; no operational default exists`);
  return value;
}

function authorization(): string {
  return argument("--authorization");
}

const command = process.argv[2];
if (command === "backup") {
  const result = await createCanonicalBackup({ sourceRoot: argument("--source"), outputPath: argument("--output"), authorization: authorization(), writerQuiesced: true });
  console.log(JSON.stringify({ command, backup_id: result.backupId, archive: result.archivePath, archive_bytes: result.archiveBytes, archive_sha256: result.archiveSha256, verification_state: result.manifest.verification_state }));
} else if (command === "verify") {
  const result = verifyCanonicalBackup(argument("--archive"));
  console.log(JSON.stringify({ command, backup_id: result.manifest.backup_id, archive_bytes: result.archiveBytes, archive_sha256: result.archiveSha256, verification_state: result.manifest.verification_state }));
} else if (command === "restore") {
  const result = restoreCanonicalBackup({ archivePath: argument("--archive"), targetRoot: argument("--target"), authorization: authorization() });
  console.log(JSON.stringify({ command, backup_id: result.backupId, target: result.targetRoot, state: result.state, operation_id: result.operationId }));
} else {
  throw new Error("usage: backup|verify|restore with explicit paths and --authorization");
}

if (authorization() !== CANONICAL_BACKUP_AUTHORIZATION) process.exitCode = 1;
