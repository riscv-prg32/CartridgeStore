import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { validateCartridge } from "../src/cartridge.js";

const roots: string[] = [];
function fixture(entries: Record<string, Uint8Array>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-cli-test-"));
  roots.push(root);
  const file = path.join(root, "release.zip");
  fs.writeFileSync(file, zipSync(entries));
  return file;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("cartridge validation", () => {
  it("accepts a bounded cartridge manifest with supported architectures", () => {
    const file = fixture({
      "manifest.json": strToU8(JSON.stringify({ id: "org.example.game", version: "1.0.0", architectures: [{ id: "qemu", file: "qemu.prg32" }] })),
      "qemu.prg32": new Uint8Array([1, 2, 3])
    });
    const result = validateCartridge(file);
    expect(result.id).toBe("org.example.game");
    expect(result.architectures).toEqual(["qemu"]);
    expect(result.manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects unsafe archive paths", () => {
    const file = fixture({ "../manifest.json": strToU8("{}") });
    expect(() => validateCartridge(file)).toThrowError(/unsafe/u);
  });

  it("rejects missing architecture binaries", () => {
    const file = fixture({ "manifest.json": strToU8(JSON.stringify({ id: "x", version: "1", architectures: [{ id: "qemu", file: "missing.prg32" }] })) });
    expect(() => validateCartridge(file)).toThrowError(/missing/u);
  });
});
