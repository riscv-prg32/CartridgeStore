#!/usr/bin/env node
import { resolveGlobalOptions } from "./config.js";
import { execute, emit, printHelp } from "./commands.js";
import { printError } from "./output.js";

const VERSION = "0.1.0";

function parse(argv: readonly string[]): { readonly command?: string; readonly subcommand?: string; readonly values: Record<string, string | boolean>; readonly globals: Record<string, string | boolean> } {
  const values: Record<string, string | boolean> = {};
  const globals: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const globalNames = new Set(["server", "token", "token-file", "token-env", "timeout"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") { globals.help = true; continue; }
    if (arg === "--version" || arg === "-v") { globals.version = true; continue; }
    if (arg === "--json" || arg === "--quiet" || arg === "--no-color" || arg === "--yes" || arg === "--confirm") { globals[arg.slice(2)] = true; continue; }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (!globalNames.has(name) && next === undefined) { values[name] = true; continue; }
      if (globalNames.has(name)) {
        if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
        globals[name] = next; index += 1; continue;
      }
      if (!next || next.startsWith("--")) { values[name] = true; continue; }
      values[name] = next; index += 1; continue;
    }
    positional.push(arg);
  }
  if (positional[2]) values._arg = positional[2];
  return { ...(positional[0] ? { command: positional[0] } : {}), ...(positional[1] ? { subcommand: positional[1] } : {}), values, globals };
}

async function main(): Promise<number> {
  let options;
  try {
    const parsed = parse(process.argv.slice(2));
    options = resolveGlobalOptions(parsed.globals);
    if (parsed.globals.version) { process.stdout.write(`${VERSION}\n`); return 0; }
    if (parsed.globals.help || !parsed.command) { printHelp(parsed.command); return 0; }
    emit(await execute(parsed.command, parsed.subcommand, parsed.values, options), options);
    return 0;
  } catch (error) {
    return printError(error, options ?? resolveGlobalOptions({}));
  }
}

process.exitCode = await main();
