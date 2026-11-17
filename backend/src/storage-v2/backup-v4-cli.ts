import { KeyRegistry } from "../secrets/registry.js";
import {
  KeyRegistryBackupKeyProvider,
  applyBackupRetention,
  createEncryptedCanonicalBackup,
  inspectEncryptedBackup,
  rotateBackupKeyRegistry,
  restoreEncryptedBackup,
  verifyEncryptedBackup
} from "./backup-v4.js";

const args = process.argv.slice(2).filter((value, index) => !(index === 0 && value === "--"));

function argument(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required; no operational default exists`);
  return value;
}

function provider(): KeyRegistryBackupKeyProvider {
  const registryPath = argument("--key-registry");
  return new KeyRegistryBackupKeyProvider(KeyRegistry.fromFile(registryPath));
}

function authorization(): string { return argument("--authorization"); }

function snapshotMode(): "exclusive" | "online" {
  const online = args.includes("--online");
  const exclusive = args.includes("--exclusive");
  if (online && exclusive) throw new Error("--online and --exclusive are mutually exclusive");
  return online ? "online" : "exclusive";
}

try {
  const command = args[0];
  if (command === "help" || command === "--help" || command === undefined) {
    console.log("usage: backup [--online|--exclusive]|verify|inspect|restore|retention|rotate-key-registry with explicit paths and authorization; backup/restore never use operational defaults");
  } else if (command === "backup") {
    const mode = snapshotMode();
    const result = await createEncryptedCanonicalBackup({ sourceRoot: argument("--source"), outputPath: argument("--output"), authorization: authorization(), keyProvider: provider(), writerQuiesced: mode === "exclusive", snapshotMode: mode });
    console.log(JSON.stringify({ command, backup_id: result.backupId, archive: result.archivePath, archive_bytes: result.envelopeBytes, key_id: result.header.key_id, verification_state: "complete" }));
  } else if (command === "verify") {
    const result = verifyEncryptedBackup(argument("--archive"), { keyProvider: provider() });
    console.log(JSON.stringify({ command, backup_id: result.backupId, archive_bytes: result.envelopeBytes, archive_sha256: result.payloadArchiveSha256, key_id: result.header.key_id, verification_state: result.payloadManifest.verification_state }));
  } else if (command === "inspect") {
    const header = inspectEncryptedBackup(argument("--archive"));
    console.log(JSON.stringify({ command, backup_id: header.backup_id, format: header.abi, key_id: header.key_id, created_at: header.created_at, payload_archive_bytes: header.payload_archive_bytes }));
  } else if (command === "restore") {
    const result = restoreEncryptedBackup({ archivePath: argument("--archive"), targetRoot: argument("--target"), authorization: authorization(), keyProvider: provider() });
    console.log(JSON.stringify({ command, backup_id: result.backupId, target: result.targetRoot, state: result.state, operation_id: result.operationId }));
  } else if (command === "retention") {
    const result = applyBackupRetention({ directory: argument("--directory"), keepNewest: Number(argument("--keep-newest")), ...(args.includes("--max-age-ms") ? { maxAgeMs: Number(argument("--max-age-ms")) } : {}), protectedBackupIds: args.includes("--protect") ? argument("--protect").split(",").filter(Boolean) : [], apply: args.includes("--apply"), ...(args.includes("--apply") ? { authorization: authorization() } : {}) });
    console.log(JSON.stringify({ command, dry_run: result.dryRun, candidates: result.candidates, protected: result.protectedFiles, deleted: result.deleted }));
  } else if (command === "rotate-key-registry") {
    const result = rotateBackupKeyRegistry({ inputRegistryPath: argument("--key-registry"), outputRegistryPath: argument("--output"), newKeyId: argument("--new-key-id") });
    console.log(JSON.stringify({ command, output: result.outputPath, active_key_id: result.activeKeyId, retained_key_ids: result.retainedKeyIds }));
  } else {
    throw new Error("usage: backup|verify|inspect|restore|retention|rotate-key-registry with explicit paths and authorization");
  }
} catch (error) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "backup_v4_command_failed";
  console.error(JSON.stringify({ error: { code } }));
  process.exitCode = 1;
}
