import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.js";

export interface GlobalOptions {
  readonly server?: string;
  readonly token?: string;
  readonly tokenFile?: string;
  readonly tokenEnv?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly noColor: boolean;
  readonly yes: boolean;
}

interface ProtectedConfig { readonly server?: string; readonly token_file?: string; }

function protectedConfigPath(): string { return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "prg32-store", "config.json"); }

function readProtectedConfig(): ProtectedConfig {
  const file = protectedConfigPath();
  if (!fs.existsSync(file)) return {};
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { throw new CliError("config_unavailable", "protected CLI configuration is unavailable", 1); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new CliError("config_permissions", "protected CLI configuration has unsafe permissions", 1);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.server === "string" ? { server: record.server } : {}),
      ...(typeof record.token_file === "string" ? { token_file: record.token_file } : {})
    };
  } catch { throw new CliError("config_invalid", "protected CLI configuration is invalid", 1); }
}

function readTokenFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(resolved); } catch { throw new CliError("token_unavailable", "API token file is unavailable", 3); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new CliError("token_permissions", "API token file has unsafe permissions", 3);
  const token = fs.readFileSync(resolved, "utf8").trim();
  if (!token) throw new CliError("token_empty", "API token is empty", 3);
  return token;
}

export function resolveGlobalOptions(raw: Record<string, string | boolean>): GlobalOptions {
  const protectedConfig = readProtectedConfig();
  const tokenFile = typeof raw["token-file"] === "string" ? raw["token-file"] : process.env.PRG32_STORE_TOKEN_FILE ?? protectedConfig.token_file;
  const tokenEnv = typeof raw["token-env"] === "string" ? raw["token-env"] : "PRG32_STORE_TOKEN";
  const token = typeof raw.token === "string"
    ? raw.token
    : tokenFile !== undefined
      ? readTokenFile(tokenFile)
      : process.env[tokenEnv] ?? undefined;
  const server = typeof raw.server === "string" ? raw.server : process.env.PRG32_STORE_URL ?? protectedConfig.server;
  const timeoutValue = typeof raw.timeout === "string" ? Number(raw.timeout) : 10000;
  if (!Number.isSafeInteger(timeoutValue) || timeoutValue < 100 || timeoutValue > 120000) throw new CliError("invalid_timeout", "timeout must be between 100 and 120000 milliseconds", 2);
  return {
    ...(server === undefined ? {} : { server: server.replace(/\/+$/u, "") }),
    ...(token === undefined ? {} : { token }),
    ...(tokenFile === undefined ? {} : { tokenFile }),
    ...(typeof raw["token-env"] === "string" ? { tokenEnv: raw["token-env"] } : {}),
    timeoutMs: timeoutValue,
    json: raw.json === true,
    quiet: raw.quiet === true,
    noColor: raw["no-color"] === true,
    yes: raw.yes === true || raw.confirm === true
  };
}

export function requireServer(options: GlobalOptions): string {
  if (!options.server) throw new CliError("server_required", "server URL is required; use --server or PRG32_STORE_URL", 2);
  let url: URL;
  try { url = new URL(options.server); } catch { throw new CliError("server_invalid", "server URL is invalid", 2); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new CliError("insecure_server", "authenticated remote operations require HTTPS; HTTP is allowed only for loopback development", 2);
  return url.toString().replace(/\/+$/u, "");
}

export function requireToken(options: GlobalOptions): string {
  if (!options.token) throw new CliError("token_required", "API token is required; use --token-env or --token-file", 3);
  return options.token;
}
