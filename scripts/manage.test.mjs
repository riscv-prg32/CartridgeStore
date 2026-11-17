import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { EXIT, normalizeComposeServices, parseArgs, parseCommandArgs } from "./manage.mjs";

const execFileAsync = promisify(execFile);

test("parser keeps profiles on a fixed allow-list boundary", () => {
  const parsed = parseArgs(["--json", "--profile", "candidate", "status"]);
  assert.equal(parsed.globals.profile, "candidate");
  assert.equal(parsed.globals.explicitProfile, true);
  assert.equal(parsed.command, "status");
});

test("help command matches the documented operator entry point", async () => {
  const result = await execFileAsync("./manage.sh", ["help"], { cwd: process.cwd() });
  assert.match(result.stdout, /^Usage: \.\/manage\.sh/m);
});

test("command parser rejects hostile and unknown options", () => {
  assert.throws(() => parseCommandArgs(["--service", "backend", "--unknown"]), /unknown option/);
  assert.throws(() => parseCommandArgs(["--tail", "-1"]), /tail_invalid|between/);
  assert.equal(parseCommandArgs(["--service", "backend;touch /tmp/pwned"]).service, "backend;touch /tmp/pwned");
});

test("compose JSON is normalized without trusting service names as commands", () => {
  const services = normalizeComposeServices(JSON.stringify([{ Service: "fastify", Name: "candidate-fastify-1", State: "running", Health: "healthy", Status: "Up" }]));
  assert.deepEqual(services, [{ service: "fastify", name: "candidate-fastify-1", state: "running", status: "Up", health: "healthy" }]);
});

test("update check is read-only and returns valid JSON", async () => {
  const result = await execFileAsync("./manage.sh", ["--json", "update", "check"], { cwd: process.cwd() });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "update check");
  assert.equal(payload.status, "NO_UPDATE_SOURCE_CONFIGURED");
});

test("update apply dry-run fails closed without mutating services", async () => {
  await assert.rejects(
    execFileAsync("./manage.sh", ["--json", "update", "apply", "--dry-run"], { cwd: process.cwd() }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.status, "BLOCKED");
      assert.equal(error.code, EXIT.BLOCKED);
      return true;
    }
  );
});

test("invalid profiles and service names fail before Docker is invoked", async () => {
  await assert.rejects(execFileAsync("./manage.sh", ["--json", "--profile", "not-a-profile", "status"], { cwd: process.cwd() }), (error) => {
    assert.equal(error.code, EXIT.USAGE);
    assert.equal(JSON.parse(error.stdout).error.code, "profile_invalid");
    return true;
  });
  await assert.rejects(execFileAsync("./manage.sh", ["--json", "logs", "--service", "backend;touch /tmp/prg32"], { cwd: process.cwd() }), (error) => {
    assert.equal(error.code, EXIT.USAGE);
    assert.equal(JSON.parse(error.stdout).error.code, "service_invalid");
    return true;
  });
});
