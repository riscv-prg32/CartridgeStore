import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupList } from "../src/local-backup.js";

describe("backup listing", () => {
  it("lists only backup-v4 archive files and completion state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-backup-list-"));
    try {
      fs.writeFileSync(path.join(root, "one.backup4"), Buffer.alloc(4));
      fs.writeFileSync(path.join(root, "one.backup4.complete.json"), "{}");
      fs.writeFileSync(path.join(root, "notes.txt"), "ignored");
      expect(backupList({ directory: root })).toEqual({ directory: root, backups: [{ archive: path.join(root, "one.backup4"), bytes: 4, completion_marker: true }] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
