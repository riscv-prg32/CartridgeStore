import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(process.cwd(), "..");
const firmwareRoot = path.resolve(repositoryRoot, "../PRG32");

function firmwareText(relativePath: string): string {
  return fs.readFileSync(path.join(firmwareRoot, relativePath), "utf8");
}

describe("companion firmware contract", () => {
  it("keeps discovery and architecture constants aligned with the read-only companion repository", () => {
    const config = firmwareText("main/prg32_config.h");
    const utils = firmwareText("prg32/store/utils.py");
    const storeApi = firmwareText("prg32/store/store_api.py");
    expect(config).toContain('#define PRG32_STORE_MDNS_SERVICE "_prg32store"');
    expect(config).toContain("#define PRG32_STORE_DEFAULT_PORT 5080");
    expect(utils).toContain('STORE_DISCOVERY_ABI = "prg32-store-discovery-1.0"');
    expect(storeApi).toContain('"/.well-known/prg32-store.json"');
    expect(storeApi).toContain('"/api/games?limit=100"');
    expect(storeApi).toContain('"/api/games/"');
    expect(firmwareText("tools/prg32_cartridge_format.py")).toMatch(/"esp32c6"[\s\S]*"qemu"/u);
  });

  it("does not mutate the companion repository while collecting evidence", () => {
    expect(fs.existsSync(path.join(firmwareRoot, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(firmwareRoot, ".git"))).toBe(true);
  });
});
