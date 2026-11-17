import fs from "node:fs";
import { execFileSync } from "node:child_process";

export default async function globalTeardown() {
  const runtimePath = process.env.PRG32_M52G14_RUNTIME;
  if (!runtimePath || !fs.existsSync(runtimePath)) return;
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  for (const pid of [runtime.nextPid, runtime.backendPid]) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
  }
  if (runtime.composeProject && runtime.composeFile) {
    try {
      execFileSync("docker", ["compose", "-p", runtime.composeProject, "-f", runtime.composeFile, "down", "--volumes", "--remove-orphans"], {
        cwd: runtime.repo,
        stdio: "ignore"
      });
    } catch { /* global setup failure may have already removed the disposable stack */ }
  }
  fs.rmSync(runtime.tempRoot, { recursive: true, force: true });
}
