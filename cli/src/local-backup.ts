import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError } from "./errors.js";

const execFileAsync = promisify(execFile);
const BACKUP_AUTHORIZATION = "PRG32_STORAGE_V2_ENCRYPTED_BACKUP_OPERATIONAL";

function repositoryRoot(): string {
  return process.env.PRG32_STORE_REPOSITORY_ROOT ? path.resolve(process.env.PRG32_STORE_REPOSITORY_ROOT) : path.resolve(import.meta.dirname, "../..");
}

function localCommand(): { readonly command: string; readonly argsPrefix: readonly string[]; readonly cwd: string } {
  const root = repositoryRoot();
  const built = path.join(root, "backend", "dist", "storage-v2", "backup-v4-cli.js");
  if (fs.existsSync(built)) return { command: process.execPath, argsPrefix: [built], cwd: root };
  return { command: "pnpm", argsPrefix: ["--dir", "backend", "exec", "tsx", "src/storage-v2/backup-v4-cli.ts"], cwd: root };
}

async function runBackend(args: readonly string[]): Promise<Record<string, unknown>> {
  const command = localCommand();
  try {
    const result = await execFileAsync(command.command, [...command.argsPrefix, ...args], { cwd: command.cwd, maxBuffer: 1024 * 1024, env: { ...process.env } });
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error();
    const value = JSON.parse(line) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const output = `${stdout}\n${stderr}`;
    try {
      const lines = output.trim().split("\n").filter(Boolean);
      const parsed = JSON.parse(lines.at(-1) ?? "") as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
        const code = typeof (parsed as Record<string, unknown>).error === "object" && (parsed as Record<string, unknown>).error !== null && typeof ((parsed as Record<string, unknown>).error as Record<string, unknown>).code === "string"
          ? ((parsed as Record<string, unknown>).error as Record<string, unknown>).code as string : "backup_command_failed";
        throw new CliError(code, "backup operation failed", backupExitCode(code));
      }
    } catch (parseError) { if (parseError instanceof CliError) throw parseError; }
    throw new CliError("backup_command_failed", "backup operation failed", 1);
  }
}

function backupExitCode(code: string): 1 | 3 | 5 | 7 {
  if (/(?:authentication|authorization|key)/iu.test(code)) return code.includes("authorization") ? 3 : 7;
  if (/(?:integrity|payload|truncated|corrupt|tamper|wrong)/iu.test(code)) return 7;
  if (/(?:lock|busy|conflict|target)/iu.test(code)) return 5;
  return 1;
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CliError("usage", `${name} is required`, 2);
  return value;
}

export async function backupCreate(values: Record<string, string | boolean>): Promise<Record<string, unknown>> {
  return runBackend(["backup", "--source", required(values.source, "--source"), "--output", required(values.output, "--output"), "--key-registry", required(values["key-registry"], "--key-registry"), "--authorization", typeof values.authorization === "string" ? values.authorization : BACKUP_AUTHORIZATION]);
}

export async function backupVerify(values: Record<string, string | boolean>): Promise<Record<string, unknown>> {
  return runBackend(["verify", "--archive", required(values.archive, "--archive"), "--key-registry", required(values["key-registry"], "--key-registry")]);
}

export async function backupRestore(values: Record<string, string | boolean>): Promise<Record<string, unknown>> {
  if (values.yes !== true && values.confirm !== true) throw new CliError("confirmation_required", "restore requires --yes or --confirm", 2);
  return runBackend(["restore", "--archive", required(values.archive, "--archive"), "--target", required(values.target, "--target"), "--key-registry", required(values["key-registry"], "--key-registry"), "--authorization", typeof values.authorization === "string" ? values.authorization : BACKUP_AUTHORIZATION]);
}

export function backupList(values: Record<string, string | boolean>): Record<string, unknown> {
  const directory = path.resolve(required(values.directory, "--directory"));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); } catch { throw new CliError("backup_directory_unavailable", "backup directory is unavailable", 2); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliError("backup_directory_unsafe", "backup directory is unsafe", 2);
  const backups = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".backup4")).map((entry) => {
    const archive = path.join(directory, entry.name);
    const archiveStat = fs.statSync(archive);
    return { archive, bytes: archiveStat.size, completion_marker: fs.existsSync(`${archive}.complete.json`) };
  });
  return { directory, backups };
}
