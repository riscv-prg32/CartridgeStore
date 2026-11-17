import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { EXIT, ManagementError, fail } from "./core.mjs";

const execFileAsync = promisify(execFile);

/** Parses one JSON object or newline-delimited compose output. */
export function parseJsonLines(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // Compose may emit one object per line.
  }
  return trimmed
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

/** Normalizes Docker Compose service records for management output. */
export function normalizeComposeServices(output) {
  const parsed = parseJsonLines(output);
  const rows = parsed.flatMap((item) => (Array.isArray(item) ? item : [item]));
  return rows.map((row) => ({
    service: row.Service ?? row.service ?? null,
    name: row.Name ?? row.name ?? null,
    state: row.State ?? row.state ?? null,
    status: row.Status ?? row.status ?? null,
    health: row.Health || row.health || "unknown",
  }));
}

/** Creates process and Docker Compose operations for management commands. */
export function createManagementRuntime({ root, redact, safePath }) {
  async function runFile(command, args, ctx, options = {}) {
    const timeoutMs = (ctx?.globals?.timeout ?? 30) * 1000;
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? timeoutMs,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        code: 0,
        stdout: redact(ctx, result.stdout),
        stderr: redact(ctx, result.stderr),
      };
    } catch (error) {
      const timedOut = error?.killed === true || error?.signal === "SIGTERM";
      if (timedOut) fail("timeout", `${command} timed out`, EXIT.TIMEOUT);
      const stderr = redact(ctx, error?.stderr ?? "");
      const stdout = redact(ctx, error?.stdout ?? "");
      const hint = stderr.trim().split(/\r?\n/u).filter(Boolean).at(-1);
      throw new ManagementError(
        "subprocess_failed",
        `${command} exited with code ${error?.code ?? 1}${
          hint ? `: ${hint}` : ""
        }`,
        EXIT.FAILED,
        {
          command,
          args,
          stdout,
          stderr,
          status: error?.code ?? 1,
        },
      );
    }
  }

  async function requireDocker(ctx) {
    try {
      await runFile(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        ctx,
        { timeoutMs: 5000 },
      );
    } catch (error) {
      if (
        error instanceof ManagementError &&
        error.code === "subprocess_failed"
      ) {
        fail(
          "docker_unavailable",
          "Docker daemon is unavailable",
          EXIT.DEPENDENCY,
        );
      }
      throw error;
    }
    try {
      await runFile(
        "docker",
        ["compose", "version", "--short"],
        ctx,
        { timeoutMs: 5000 },
      );
    } catch (error) {
      if (
        error instanceof ManagementError &&
        error.code === "subprocess_failed"
      ) {
        fail(
          "compose_unavailable",
          "Docker Compose v2 is unavailable",
          EXIT.DEPENDENCY,
        );
      }
      throw error;
    }
  }

  function composeArgs(ctx, extra = [], { scheduler = false, envFile = true } = {}) {
    const args = ["compose", "--project-name", ctx.project];
    if (envFile && ctx.globals.envFile) {
      args.push("--env-file", safePath(ctx.globals.envFile, "environment file"));
    }
    args.push("-f", ctx.composeFile);
    if (scheduler && ctx.profile.scheduler) {
      args.push("--profile", "backup-scheduler");
    }
    return [...args, ...extra];
  }

  async function runCompose(ctx, extra, options = {}) {
    return runFile("docker", composeArgs(ctx, extra, options), ctx, options);
  }

  async function composeServices(ctx, { all = true, scheduler = false } = {}) {
    const result = await runCompose(
      ctx,
      ["ps", ...(all ? ["--all"] : []), "--format", "json"],
      { scheduler },
    );
    return normalizeComposeServices(result.stdout);
  }

  function servicesSummary(rows, ctx) {
    const wanted = [
      ...ctx.profile.services,
      ...(ctx.profile.scheduler ? ["backup-scheduler"] : []),
    ];
    return wanted.map((service) => {
      const row = rows.find(
        (candidate) =>
          candidate.service === service ||
          candidate.name?.startsWith(`${ctx.project}-${service}`),
      );
      return {
        service,
        present: Boolean(row),
        running: row?.state === "running",
        state: row?.state ?? "not_created",
        status: row?.status ?? null,
        health: row?.health ?? "unknown",
      };
    });
  }

  return {
    composeArgs,
    composeServices,
    requireDocker,
    runCompose,
    runFile,
    servicesSummary,
  };
}
