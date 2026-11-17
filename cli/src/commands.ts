import fs from "node:fs";
import type { GlobalOptions } from "./config.js";
import { StoreClient } from "./http.js";
import { validateCartridge } from "./cartridge.js";
import { backupCreate, backupList, backupRestore, backupVerify } from "./local-backup.js";
import { printResult, usageError } from "./output.js";

type Values = Record<string, string | boolean>;

function value(values: Values, key: string, required = true): string | undefined {
  const candidate = values[key];
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  if (required) usageError(`--${key} is required`);
  return undefined;
}

function client(options: GlobalOptions): StoreClient { return new StoreClient(options); }

export function printHelp(command?: string): void {
  const lines: Record<string, string> = {
    root: "Usage: prg32-store [global options] <status|version|doctor|games|cartridges|submissions|users|backup>",
    status: "Usage: prg32-store status [--server URL] [--json]",
    version: "Usage: prg32-store version [--server URL] [--json]",
    doctor: "Usage: prg32-store doctor [--server URL] [--json]",
    games: "Usage: prg32-store games <list|show|search> [options]",
    cartridges: "Usage: prg32-store cartridges <validate|upload> <file> [options]",
    submissions: "Usage: prg32-store submissions <list|show|approve|reject> [id] [options]",
    users: "Usage: prg32-store users <list|show> [id] [options]",
    backup: "Usage: prg32-store backup <create|list|verify|restore> [options]"
  };
  process.stdout.write(`${lines[command ?? "root"] ?? lines.root}\n`);
}

export async function execute(command: string, subcommand: string | undefined, values: Values, options: GlobalOptions): Promise<unknown> {
  if (command === "status") {
    const store = new StoreClient(options);
    const health = await store.request<Record<string, unknown>>("/health", { auth: false });
    let ready: unknown;
    try { ready = await store.request<Record<string, unknown>>("/ready", { auth: false }); } catch { ready = { ok: false, status: "not_ready" }; }
    return { cli: "prg32-store", server: store.baseUrl, health, ready };
  }
  if (command === "version") return { cli: "prg32-store", version: "0.1.0" };
  if (command === "doctor") {
    const store = new StoreClient(options);
    const checks: Record<string, unknown> = {};
    checks.health = await store.request("/health", { auth: false });
    try { checks.readiness = await store.request("/ready", { auth: false }); } catch { checks.readiness = { ok: false }; }
    try { checks.discovery = await store.request("/.well-known/prg32-store.json", { auth: false }); } catch { checks.discovery = { ok: false, status: "unavailable" }; }
    return { server: store.baseUrl, checks, ok: (checks.health as Record<string, unknown>).ok === true && (checks.readiness as Record<string, unknown>).ok === true };
  }
  if (command === "games") {
    const store = client(options);
    if (subcommand === "list" || subcommand === "search") {
      const query = new URLSearchParams();
      const search = value(values, "query", false) ?? value(values, "q", false);
      if (search) query.set("q", search);
      for (const key of ["page", "per_page", "limit", "version", "architecture"]) { const current = value(values, key, false); if (current) query.set(key, current); }
      return store.request(`/api/games${query.size ? `?${query}` : ""}`, { auth: false });
    }
    if (subcommand === "show") return store.request(`/api/games/${encodeURIComponent(value(values, "id")!)}`, { auth: false });
    usageError("games subcommand must be list, show or search");
  }
  if (command === "cartridges") {
    const file = value(values, "file", false) ?? (typeof values._arg === "string" ? values._arg : undefined);
    if (!file) usageError("cartridge file is required");
    if (subcommand === "validate") return validateCartridge(file);
    if (subcommand === "upload") {
      const validation = validateCartridge(file);
      const bytes = fs.readFileSync(validation.file);
      return client(options).upload("/api/publish/bundle", bytes, validation.file.split("/").at(-1) ?? "cartridge.zip");
    }
    usageError("cartridges subcommand must be validate or upload");
  }
  if (command === "submissions") {
    const store = client(options);
    if (subcommand === "list") { const status = value(values, "status", false); return store.request(`/api/submissions${status ? `?status=${encodeURIComponent(status)}` : ""}`); }
    const id = value(values, "id") ?? (typeof values._arg === "string" ? values._arg : undefined);
    if (!id) usageError("submission id is required");
    if (subcommand === "show") return store.request(`/api/submissions/${encodeURIComponent(id)}`);
    if (subcommand === "approve") return store.request(`/api/submissions/${encodeURIComponent(id)}/verify`, { method: "POST", body: JSON.stringify({ ...(typeof values.metadata === "string" ? { metadata: JSON.parse(values.metadata) } : {}), ...(typeof values.note === "string" ? { note: values.note } : {}) }), contentType: "application/json" });
    if (subcommand === "reject") return store.request(`/api/submissions/${encodeURIComponent(id)}/reject`, { method: "POST", body: JSON.stringify({ ...(typeof values.note === "string" ? { note: values.note } : {}) }), contentType: "application/json" });
    usageError("submissions subcommand must be list, show, approve or reject");
  }
  if (command === "users") {
    const store = client(options);
    if (subcommand === "list") return store.request(`/api/admin/users${value(values, "limit", false) ? `?limit=${value(values, "limit", false)}` : ""}`);
    if (subcommand === "show") return store.request(`/api/admin/users/${encodeURIComponent(value(values, "id")!)}`);
    usageError("users currently supports only list and show; mutating user administration requires the browser session and CSRF contract");
  }
  if (command === "backup") {
    if (subcommand === "create") return backupCreate(values);
    if (subcommand === "list") return backupList(values);
    if (subcommand === "verify") return backupVerify(values);
    if (subcommand === "restore") return backupRestore({ ...values, yes: options.yes });
    usageError("backup subcommand must be create, list, verify or restore");
  }
  usageError(`unknown command: ${command}`);
}

export function emit(valueToPrint: unknown, options: GlobalOptions): void { printResult(valueToPrint, options); }
