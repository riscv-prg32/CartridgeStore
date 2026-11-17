import fs from "node:fs";
import path from "node:path";

import { EXIT, fail, parseCommandArgs } from "./core.mjs";

/**
 * Build the management backup command from the shared runtime utilities.
 *
 * Keeping the utilities injected preserves the existing path and subprocess
 * policy while isolating backup-specific orchestration.
 */
export function createBackupCommand({
  root,
  value,
  configValues,
  directoryStat,
  safePath,
  regularStat,
  runFile,
  parseJsonLines,
  profileRequiresExplicitMutation,
  success
}) {
  function backupPaths(
    ctx,
    {
      sourceRequired = true,
      registryRequired = true,
      authorizationRequired = true
    } = {}
  ) {
    const configured = configValues(ctx);
    const source = value(ctx, "PRG32_BACKUP_SOURCE") ?? configured.data;
    const destination =
      value(ctx, "PRG32_BACKUP_DESTINATION") ?? configured.backupDestination;
    const registry =
      value(ctx, "PRG32_BACKUP_KEY_REGISTRY") ?? configured.keyRegistry;
    const authorization = value(ctx, "PRG32_BACKUP_AUTHORIZATION");
    if (
      !destination ||
      (sourceRequired && !source) ||
      (registryRequired && !registry) ||
      (authorizationRequired && !authorization)
    ) {
      fail(
        "backup_configuration_missing",
        "backup paths and required authorization must be explicitly configured",
        EXIT.CONFIG
      );
    }
    const sourceInfo = source
      ? directoryStat(source, "backup source")
      : undefined;
    const destinationInfo = directoryStat(
      destination,
      "backup destination"
    );
    let registryPath;
    if (registry) {
      registryPath = safePath(registry, "backup key registry");
      const registryStat = regularStat(registryPath, "backup key registry");
      if ((registryStat.mode & 0o077) !== 0) {
        fail(
          "backup_key_permissions",
          "backup key registry must not be group/world-readable",
          EXIT.CONFIG
        );
      }
    }
    if (
      sourceInfo &&
      (path.resolve(sourceInfo.path) === path.resolve(destinationInfo.path) ||
        (path.relative(sourceInfo.path, destinationInfo.path) &&
          !path
            .relative(sourceInfo.path, destinationInfo.path)
            .startsWith("..")))
    ) {
      fail(
        "backup_path_overlap",
        "backup destination must be outside the canonical source",
        EXIT.CONFIG
      );
    }
    return {
      source: sourceInfo?.path,
      destination: destinationInfo.path,
      registry: registryPath,
      authorization
    };
  }

  function backupWrapper(ctx) {
    const wrapper =
      value(ctx, "PRG32_BACKUP_WRAPPER") ??
      path.join(root, "deploy", "operations", "backup", "prg32-backup.mjs");
    const cli =
      value(ctx, "PRG32_BACKUP_CLI_BIN") ??
      path.join(root, "backend", "dist", "storage-v2", "backup-v4-cli.js");
    regularStat(safePath(wrapper, "backup wrapper"), "backup wrapper");
    regularStat(safePath(cli, "backup CLI"), "backup CLI");
    return {
      wrapper: safePath(wrapper, "backup wrapper"),
      cli: safePath(cli, "backup CLI")
    };
  }

  async function runBackupWrapper(ctx, operation, extraEnv = {}) {
    const paths = backupPaths(ctx, {
      sourceRequired: operation === "create",
      registryRequired: operation !== "status",
      authorizationRequired: operation === "create"
    });
    const wrapper =
      operation === "status"
        ? {
            wrapper: safePath(
              value(ctx, "PRG32_BACKUP_WRAPPER") ??
                path.join(
                  root,
                  "deploy",
                  "operations",
                  "backup",
                  "prg32-backup.mjs"
                ),
              "backup wrapper"
            )
          }
        : backupWrapper(ctx);
    const env = {
      ...process.env,
      PRG32_BACKUP_SOURCE: paths.source,
      PRG32_BACKUP_DESTINATION: paths.destination,
      PRG32_BACKUP_KEY_REGISTRY: paths.registry,
      PRG32_BACKUP_AUTHORIZATION: paths.authorization,
      PRG32_BACKUP_WRAPPER: wrapper.wrapper,
      PRG32_BACKUP_CLI_BIN: wrapper.cli,
      PRG32_BACKUP_SNAPSHOT_MODE:
        value(ctx, "PRG32_BACKUP_SNAPSHOT_MODE") ?? "online",
      ...extraEnv
    };
    const result = await runFile(
      process.execPath,
      [wrapper.wrapper, operation],
      ctx,
      { env, timeoutMs: ctx.globals.timeout * 1000 }
    );
    const payload = parseJsonLines(result.stdout).at(-1);
    if (!payload) {
      fail(
        "backup_invalid_output",
        "backup wrapper returned no structured output",
        EXIT.BACKUP
      );
    }
    return payload;
  }

  function listBackups(ctx) {
    const { destination } = backupPaths(ctx, {
      sourceRequired: false,
      registryRequired: false,
      authorizationRequired: false
    });
    const archives = fs
      .readdirSync(destination, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*\.backup4$/u.test(entry.name)
      )
      .map((entry) => {
        const filePath = path.join(destination, entry.name);
        const stat = fs.statSync(filePath);
        return {
          archive: entry.name,
          bytes: stat.size,
          completion_marker: fs.existsSync(`${filePath}.complete.json`),
          verified_marker: fs.existsSync(`${filePath}.verified.json`)
        };
      });
    return { command: "backup list", directory: destination, archives };
  }

  return async function backup(ctx, subcommand) {
    if (!["create", "list", "verify", "status"].includes(subcommand)) {
      fail(
        "usage",
        "backup subcommand must be create, list, verify or status",
        EXIT.USAGE
      );
    }
    if (subcommand === "create") profileRequiresExplicitMutation(ctx);
    if (subcommand === "list") return success(listBackups(ctx));
    const archive = ctx.commandArgs.includes("--archive")
      ? parseCommandArgs(ctx.commandArgs).archive
      : undefined;
    const payload = await runBackupWrapper(
      ctx,
      subcommand === "create" ? "create" : subcommand,
      archive
        ? { PRG32_BACKUP_ARCHIVE: safePath(archive, "backup archive") }
        : {}
    );
    return success(
      { command: `backup ${subcommand}`, ...payload },
      EXIT.OK
    );
  };
}
