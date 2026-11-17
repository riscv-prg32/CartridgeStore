import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  nextExecution,
  parseBoolean,
  parseIntervalMs,
  parseRetentionEnabled,
  parseSnapshotMode,
  schedulerStateIsHealthy,
  validateTimezone
} from "./scheduler.mjs";

test("scheduler defaults to a 24-hour interval and rejects tight polling", () => {
  assert.equal(parseIntervalMs(), DEFAULT_INTERVAL_MS);
  assert.equal(parseIntervalMs(String(MIN_INTERVAL_MS)), MIN_INTERVAL_MS);
  assert.throws(() => parseIntervalMs(String(MIN_INTERVAL_MS - 1)), /at least/);
});

test("scheduler accepts IANA timezones and strict booleans", () => {
  assert.equal(validateTimezone("UTC"), "UTC");
  assert.equal(validateTimezone("Europe/Rome"), "Europe/Rome");
  assert.equal(parseBoolean("true", "TEST"), true);
  assert.equal(parseBoolean("0", "TEST"), false);
  assert.throws(() => validateTimezone("not/a-timezone"), /IANA/);
  assert.throws(() => parseBoolean("yes", "TEST"), /true or false/);
});

test("scheduler accepts explicit online snapshots and rejects unknown modes", () => {
  assert.equal(parseSnapshotMode("online"), "online");
  assert.equal(parseSnapshotMode("exclusive"), "exclusive");
  assert.equal(parseSnapshotMode(undefined), "exclusive");
  assert.throws(() => parseSnapshotMode("quiesce"), /exclusive or online/);
});

test("scheduler retention is opt-in and uses strict booleans", () => {
  assert.equal(parseRetentionEnabled(undefined), false);
  assert.equal(parseRetentionEnabled("true"), true);
  assert.equal(parseRetentionEnabled("1"), true);
  assert.throws(() => parseRetentionEnabled("yes"), /true or false/);
});

test("next execution is calculated from the current wall clock", () => {
  const now = new Date("2026-10-16T10:00:00.000Z");
  assert.equal(nextExecution(now, DEFAULT_INTERVAL_MS).toISOString(), "2026-10-17T10:00:00.000Z");
});

test("failed state is unhealthy while an idle state is healthy", () => {
  assert.equal(schedulerStateIsHealthy({ status: "idle" }), true);
  assert.equal(schedulerStateIsHealthy({ status: "running" }), true);
  assert.equal(schedulerStateIsHealthy({ status: "failed" }), false);
  assert.equal(schedulerStateIsHealthy({ status: "stopped_with_failure" }), false);
});
