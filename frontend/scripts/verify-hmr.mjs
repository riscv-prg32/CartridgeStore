import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probeFile = resolve(frontendRoot, "src/components/foundation/FoundationShell.tsx");
const port = 3197;
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function waitForHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          resolvePromise(await response.text());
          return;
        }
      } catch {
        // The dev server is still starting.
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function waitForHmrMessage(url, triggerChange) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url);
    let changeTriggered = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for the Next.js HMR message"));
    }, 15_000);

    socket.addEventListener("open", () => {
      // The first sync message is the baseline. The probe change is applied
      // only after it so that the assertion observes a real incremental build.
    });
    socket.addEventListener("message", (event) => {
      const rawMessage = String(event.data);
      let message;
      try {
        message = JSON.parse(rawMessage);
      } catch {
        return;
      }
      if (message.type === "sync" && !changeTriggered) {
        changeTriggered = true;
        triggerChange().catch((error) => {
          clearTimeout(timeout);
          socket.close();
          reject(error);
        });
        return;
      }
      if (!changeTriggered || !["built", "serverComponentChanges", "clientChanges", "serverOnlyChanges", "reloadPage", "turbopack-message"].includes(message.type)) {
        return;
      }
      clearTimeout(timeout);
      socket.close();
      resolvePromise(rawMessage);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Could not connect to Next.js HMR endpoint ${url}`));
    });
  });
}

const original = await readFile(probeFile, "utf8");
const marker = "PRG32 Cartridge Store";
if (!original.includes(marker)) {
  throw new Error(`HMR probe marker was not found in ${probeFile}`);
}

const child = spawn(npmCommand, ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: frontendRoot,
  env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: "ignore",
});

try {
  const page = await waitForHttp(`http://127.0.0.1:${port}/`);
  const requestId = page.match(/__next_r=["']([^"']+)["']/)?.[1];
  if (!requestId) {
    throw new Error("Could not find the Next.js development request id in the page");
  }
  const message = await waitForHmrMessage(`ws://127.0.0.1:${port}/_next/hmr?id=${requestId}`, async () => {
    await writeFile(probeFile, original.replace(marker, `${marker} HMR probe`), "utf8");
  });
  console.log(`HMR message received: ${message.slice(0, 120)}`);
} finally {
  await writeFile(probeFile, original, "utf8");
  child.kill("SIGTERM");
}
