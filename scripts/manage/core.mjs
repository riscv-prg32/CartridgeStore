/** Exit codes exposed by the management CLI. */
export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  DEPENDENCY: 3,
  CONFIG: 4,
  UNHEALTHY: 5,
  AUTH: 6,
  BACKUP: 7,
  BLOCKED: 8,
  FAILED: 9,
  TIMEOUT: 10
});

/** Supported deployment profiles and their compose ownership. */
export const PROFILES = Object.freeze({
  standalone: {
    compose: "deploy/standalone/compose.yaml",
    project: "prg32-standalone",
    services: ["fastify", "next"],
    scheduler: true
  },
  candidate: {
    compose: "deploy/candidate/compose.yaml",
    project: "prg32-candidate",
    services: ["fastify", "next"],
    scheduler: false
  },
  operational: {
    compose: "deploy/operational/compose.yaml",
    project: "prg32-operational-template",
    services: ["fastify", "next"],
    scheduler: false
  }
});

/** Public service aliases accepted by the logs command. */
export const SERVICE_NAMES = Object.freeze({
  backend: "fastify",
  frontend: "next",
  scheduler: "backup-scheduler"
});

/** Environment keys redacted from management command output. */
export const SECRET_KEYS = Object.freeze([
  "PRG32_SESSION_SECRET",
  "PRG32_BOOTSTRAP_TOKEN",
  "PRG32_CANONICAL_READ_AUTHORIZATION",
  "PRG32_CANONICAL_WRITE_AUTHORIZATION",
  "PRG32_BACKUP_AUTHORIZATION",
  "PRG32_SMTP_PASSWORD",
  "PRG32_OPERATIONAL_SESSION_SECRET",
  "PRG32_OPERATIONAL_BOOTSTRAP_TOKEN",
  "PRG32_OPERATIONAL_CANONICAL_READ_AUTHORIZATION",
  "PRG32_OPERATIONAL_CANONICAL_WRITE_AUTHORIZATION",
  "PRG32_BACKUP_KEY_REGISTRY",
  "PRG32_KEY_REGISTRY_FILE",
  "PRG32_OPERATIONAL_KEY_REGISTRY_FILE"
]);

/** Structured failure used by the management command boundary. */
export class ManagementError extends Error {
  constructor(code, message, exitCode = EXIT.FAILED, details = undefined) {
    super(message);
    this.name = "ManagementError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Throw a structured management failure. */
export function fail(code, message, exitCode = EXIT.FAILED, details) {
  throw new ManagementError(code, message, exitCode, details);
}

/** Parse global options and the command/subcommand boundary. */
export function parseArgs(argv) {
  const globals = {
    json: false,
    nonInteractive: false,
    dryRun: false,
    help: false,
    profile: "standalone",
    explicitProfile: false,
    envFile: undefined,
    timeout: 300
  };
  const positional = [];
  const commandArgs = [];
  let commandStarted = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      commandStarted = true;
      continue;
    }
    const [name, inline] = arg.startsWith("--")
      ? arg.slice(2).split("=", 2)
      : [undefined, undefined];
    if (!commandStarted && (arg === "--help" || arg === "-h")) {
      globals.help = true;
      continue;
    }
    if (name === "help") {
      globals.help = true;
      continue;
    }
    if (name === "json") {
      globals.json = true;
      continue;
    }
    if (name === "non-interactive") {
      globals.nonInteractive = true;
      continue;
    }
    if (name === "dry-run") {
      globals.dryRun = true;
      continue;
    }
    if (name === "version") {
      globals.version = true;
      continue;
    }
    if (["profile", "env-file", "timeout"].includes(name)) {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) {
        fail("usage", `--${name} requires a value`, EXIT.USAGE);
      }
      if (name === "profile") {
        globals.profile = value;
        globals.explicitProfile = true;
      } else if (name === "env-file") {
        globals.envFile = value;
      } else {
        globals.timeout = Number(value);
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      const commandNeedsSubcommand = [
        "config",
        "db",
        "backup",
        "update",
        "ci"
      ].includes(positional[0]);
      if (
        positional.length === 0 ||
        (commandNeedsSubcommand && positional.length === 1)
      ) {
        positional.push(arg);
      } else {
        commandArgs.push(arg);
      }
      commandStarted = true;
      continue;
    }
    if (commandStarted) commandArgs.push(arg);
    else fail("usage", `unknown option ${arg}`, EXIT.USAGE);
  }
  if (
    !Number.isSafeInteger(globals.timeout) ||
    globals.timeout < 1 ||
    globals.timeout > 3600
  ) {
    fail(
      "timeout_invalid",
      "--timeout must be an integer between 1 and 3600 seconds",
      EXIT.USAGE
    );
  }
  return {
    globals,
    command: positional[0],
    subcommand: positional[1],
    commandArgs
  };
}

/** Print the stable operator-facing command usage. */
export function commandHelp(command) {
  const lines = {
    root:
      "Usage: ./manage.sh [global options] " +
      "<install|setup|config|start|stop|restart|status|logs|health|doctor|db|" +
      "backup|update|deploy|build|test|ci>",
    install: "Usage: ./manage.sh install [--profile standalone] [--env-file PATH]",
    setup: "Usage: ./manage.sh setup [--profile standalone]",
    config: "Usage: ./manage.sh config check [--profile PROFILE]",
    start: "Usage: ./manage.sh start [--with-scheduler]",
    stop: "Usage: ./manage.sh stop",
    restart: "Usage: ./manage.sh restart",
    status: "Usage: ./manage.sh status [--json]",
    logs: "Usage: ./manage.sh logs [--service backend|frontend|scheduler] [--tail N] [--follow]",
    health: "Usage: ./manage.sh health [--json]",
    doctor: "Usage: ./manage.sh doctor [--json]",
    db: "Usage: ./manage.sh db check [--root PATH]",
    backup: "Usage: ./manage.sh backup <create|list|verify|status> [--archive PATH] [--json]",
    update: "Usage: ./manage.sh update <check|apply> [--dry-run]",
    deploy: "Usage: ./manage.sh deploy --dry-run | --apply --non-interactive",
    build: "Usage: ./manage.sh build",
    test: "Usage: ./manage.sh test",
    ci: "Usage: ./manage.sh ci check"
  };
  process.stdout.write(`${lines[command ?? "root"] ?? lines.root}\n`);
}

/** Parse command-specific options after the command boundary. */
export function parseCommandArgs(args) {
  const values = {
    service: undefined,
    tail: 100,
    follow: false,
    scheduler: false,
    apply: false,
    root: undefined,
    archive: undefined,
    targetVersion: undefined
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--follow") {
      values.follow = true;
      continue;
    }
    if (arg === "--with-scheduler" || arg === "--scheduler") {
      values.scheduler = true;
      continue;
    }
    if (arg === "--no-scheduler") {
      values.scheduler = false;
      continue;
    }
    if (arg === "--apply") {
      values.apply = true;
      continue;
    }
    if (
      ["--service", "--tail", "--root", "--archive", "--target-version"].includes(
        arg
      )
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        fail("usage", `${arg} requires a value`, EXIT.USAGE);
      }
      if (arg === "--service") values.service = value;
      else if (arg === "--tail") values.tail = Number(value);
      else if (arg === "--root") values.root = value;
      else if (arg === "--archive") values.archive = value;
      else values.targetVersion = value;
      continue;
    }
    if (arg.startsWith("--")) {
      fail("usage", `unknown option ${arg}`, EXIT.USAGE);
    }
    fail("usage", `unexpected argument ${arg}`, EXIT.USAGE);
  }
  if (
    !Number.isSafeInteger(values.tail) ||
    values.tail < 1 ||
    values.tail > 10000
  ) {
    fail(
      "tail_invalid",
      "--tail must be an integer between 1 and 10000",
      EXIT.USAGE
    );
  }
  return values;
}
