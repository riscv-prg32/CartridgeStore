import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFixture,
  runBackupExperiment,
  runConcurrencyExperiment,
  runRateLimiterExperiment,
  runWalExperiment,
  WORKLOADS,
  type Fixture
} from "./operations/m63b-harness.js";

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe("SQLite capacity and resilience experiments", () => {
  it("keeps synthetic workload row counts and WAL checkpoint evidence bounded", () => {
    const fixture = createFixture(WORKLOADS.small);
    fixtures.push(fixture);
    const result = runWalExperiment(fixture.root);
    expect(result.readerSawCommittedRows).toBe(1);
    expect(result.beforeCheckpoint.wal).toBeGreaterThan(0);
    expect(result.truncateWhileReader.busy).toBe(1);
    expect(result.afterTruncateCheckpoint.wal).toBe(0);
    expect(result.truncateCheckpoint.busy).toBe(0);
  });

  it("demonstrates concurrent readers, a committed writer, and rollback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-m63b-test-"));
    const result = await runConcurrencyExperiment(root);
    expect(result.readerErrors).toEqual([]);
    expect(result.writerErrors).toEqual([]);
    expect(result.rowsAfterCommit).toBe(101);
    expect(result.originalRowsAfterRollback).toBe(101);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("opens a supported SQLite backup with matching integrity and rows", async () => {
    const fixture = createFixture(WORKLOADS.small);
    fixtures.push(fixture);
    const result = await runBackupExperiment(fixture);
    expect(result.sourceIntegrity).toBe("ok");
    expect(result.backupIntegrity).toBe("ok");
    expect(result.sourceRows).toBe(result.backupRows);
    expect(result.concurrentWriterErrors).toEqual([]);
    expect(result.concurrentBackupSnapshotConsistent).toBe(true);
    expect(result.corruptCopyRejected).toBe(true);
    expect(result.failedDestinationPreservedSource).toBe(true);
  });

  it("bounds the process-local score limiter and resets expired buckets", () => {
    const result = runRateLimiterExperiment();
    expect(result.burstAllowed).toBe(3);
    expect(result.burstRejected).toBe(2);
    expect(result.boundedClientCount).toBeLessThanOrEqual(4);
    expect(result.resetAllowed).toBe(true);
  });
});
