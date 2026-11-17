import fs from "node:fs";
import path from "node:path";

import { EXIT } from "./core.mjs";

const WORKSPACE_SCRIPTS = [
  ["backend", ["typecheck", "lint", "test", "build"]],
  ["frontend", ["typecheck", "lint", "test", "build"]],
  ["cli", ["typecheck", "lint", "test", "build"]]
];

/** Build repository verification commands with the shared process runtime. */
export function createVerificationCommands({
  root,
  ensureNode24,
  runFile,
  composeConfigCheck,
  profiles,
  success
}) {
  async function pnpmScript(ctx, directory, script, args = []) {
    const result = await runFile(
      "pnpm",
      ["--dir", directory, "run", script, ...args],
      ctx,
      {
        timeoutMs: ctx.globals.timeout * 1000,
        maxBuffer: 32 * 1024 * 1024
      }
    );
    return {
      command: `pnpm --dir ${directory} run ${script}`,
      output: result.stdout
    };
  }

  async function workspaceResults(ctx) {
    const results = [];
    for (const [directory, scripts] of WORKSPACE_SCRIPTS) {
      for (const script of scripts) {
        results.push(await pnpmScript(ctx, directory, script));
      }
    }
    return results;
  }

  function pythonPath() {
    const bundled = path.join(root, ".venv313", "bin", "python");
    return fs.existsSync(bundled) ? bundled : "python3";
  }

  async function pythonTests(ctx) {
    const python = pythonPath();
    const result = await runFile(
      python,
      ["-m", "pytest", "-q"],
      ctx,
      {
        env: { ...process.env, SECRET_KEY: "prg32-test-only-secret" },
        timeoutMs: ctx.globals.timeout * 1000,
        maxBuffer: 32 * 1024 * 1024
      }
    );
    return {
      command: `${python} -m pytest -q`,
      output: result.stdout
    };
  }

  async function test(ctx) {
    ensureNode24();
    const results = await workspaceResults(ctx);
    results.push(await pythonTests(ctx));
    return success(
      {
        ok: true,
        command: "test",
        suites: results.map((result) => ({
          command: result.command,
          output_tail: result.output
            .trim()
            .split(/\r?\n/u)
            .slice(-3)
            .join("\n")
        }))
      },
      EXIT.OK
    );
  }

  async function ci(ctx) {
    ensureNode24();
    const results = await workspaceResults(ctx);
    results.push(await pythonTests(ctx));
    for (const profileName of ["candidate", "standalone", "operational"]) {
      const profile = profiles[profileName];
      const composeCtx = {
        ...ctx,
        profileName,
        profile,
        composeFile: path.join(root, profile.compose),
        project: profile.project
      };
      await composeConfigCheck(composeCtx, { synthetic: true });
      results.push({
        command: `docker compose config --quiet (${profileName})`,
        output: "accepted"
      });
    }
    const rootCompose = path.join(root, "docker-compose.yml");
    await runFile(
      "docker",
      ["compose", "-f", rootCompose, "--profile", "dev", "config", "--quiet"],
      ctx,
      { timeoutMs: ctx.globals.timeout * 1000 }
    );
    results.push({
      command: "docker compose --profile dev config --quiet (root)",
      output: "accepted"
    });
    const diff = await runFile("git", ["diff", "--check"], ctx, {
      timeoutMs: 5000
    });
    results.push({ command: "git diff --check", output: diff.stdout });
    return success(
      {
        ok: true,
        command: "ci check",
        non_interactive: true,
        production_secrets_used: false,
        operational_services_started: false,
        checks: results.map((result) => ({
          command: result.command,
          status: "PASS"
        }))
      },
      EXIT.OK
    );
  }

  return { test, ci };
}
