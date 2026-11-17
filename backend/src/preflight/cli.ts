import { validatePreflightConfiguration, type PreflightProfile } from "./config.js";

function profileArgument(): PreflightProfile {
  const index = process.argv.indexOf("--profile");
  const candidate = index >= 0 ? process.argv[index + 1] : "candidate";
  if (candidate !== "candidate" && candidate !== "operational") throw new Error("--profile must be candidate or operational");
  return candidate;
}

const profile = profileArgument();
const result = validatePreflightConfiguration(process.env, profile);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
