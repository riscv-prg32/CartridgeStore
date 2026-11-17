import fs from "node:fs";
import path from "node:path";

import { SubmissionError } from "./errors.js";

export interface PendingVariant {
  readonly architecture: string;
  readonly file: string;
  readonly image: Uint8Array;
}

export interface StagedPendingVariant {
  readonly architecture: string;
  readonly file: string;
  readonly stored: string;
}

export interface PendingStorage {
  stage(submissionId: number, variants: readonly PendingVariant[]): readonly StagedPendingVariant[];
  remove(submissionId: number): void;
}

function assertDirectory(value: string, label: string): void {
  const stats = fs.lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SubmissionError(`${label} must be a regular directory`);
}

function assertSafeComponent(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) throw new SubmissionError("pending filename is unsafe");
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new SubmissionError("pending path escapes disposable root");
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new SubmissionError("pending path contains a symlink");
  }
}

export class PendingCartridgeStorage implements PendingStorage {
  readonly root: string;
  readonly pendingRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    assertDirectory(this.root, "submission disposable root");
    this.pendingRoot = path.join(this.root, "pending");
    if (fs.existsSync(this.pendingRoot)) assertDirectory(this.pendingRoot, "pending root");
    else fs.mkdirSync(this.pendingRoot, { mode: 0o700 });
  }

  stage(submissionId: number, variants: readonly PendingVariant[]): readonly StagedPendingVariant[] {
    const directoryName = String(submissionId);
    assertSafeComponent(directoryName);
    const pendingDirectory = path.join(this.pendingRoot, directoryName);
    assertNoSymlinkComponents(this.root, pendingDirectory);
    try {
      fs.mkdirSync(pendingDirectory, { mode: 0o700 });
      const staged: StagedPendingVariant[] = [];
      for (const variant of variants) {
        assertSafeComponent(variant.architecture);
        const filename = `${variant.architecture}.prg32`;
        const target = path.join(pendingDirectory, filename);
        assertNoSymlinkComponents(this.root, target);
        const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
        fs.writeFileSync(temporary, variant.image, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, target);
        staged.push({ architecture: variant.architecture, file: variant.file, stored: path.posix.join("pending", directoryName, filename) });
      }
      return staged;
    } catch (error) {
      this.remove(submissionId);
      if (error instanceof SubmissionError) throw error;
      throw new SubmissionError("pending cartridge storage failed", "submission_storage_failed", 500, { cause: error });
    }
  }

  remove(submissionId: number): void {
    const directory = path.join(this.pendingRoot, String(submissionId));
    assertNoSymlinkComponents(this.root, directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
