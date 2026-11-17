import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CartridgeVariantInventory {
  readonly architecture: string;
  readonly filename: string;
  readonly pathSafe: boolean;
  readonly exists: boolean;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly expectedSha256: string | null;
  readonly hashMatches: boolean | null;
}

export interface CartridgeGameInventory {
  readonly id: string;
  readonly versions: readonly string[];
  readonly architectures: readonly string[];
  readonly variants: readonly CartridgeVariantInventory[];
}

export interface CartridgeInventory {
  readonly abi: string | null;
  readonly indexPresent: boolean;
  readonly games: readonly CartridgeGameInventory[];
  readonly issues: readonly string[];
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function scalarString(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : fallback;
}

export function inventoryCartridgeStore(dataDirectory: string): CartridgeInventory {
  const root = path.resolve(dataDirectory);
  const indexPath = path.join(root, "index.json");
  if (!fs.existsSync(indexPath)) {
    return { abi: null, indexPresent: false, games: [], issues: ["index.json is missing"] };
  }

  const issues: string[] = [];
  let index: Record<string, unknown>;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { abi: null, indexPresent: true, games: [], issues: ["index.json is not valid JSON"] };
  }
  const gamesValue = index.games;
  if (gamesValue === null || typeof gamesValue !== "object" || Array.isArray(gamesValue)) {
    return { abi: typeof index.abi === "string" ? index.abi : null, indexPresent: true, games: [], issues: ["index.games is not an object"] };
  }

  const games: CartridgeGameInventory[] = [];
  for (const [gameId, rawGame] of Object.entries(gamesValue as Record<string, unknown>)) {
    if (rawGame === null || typeof rawGame !== "object") {
      issues.push(`game ${gameId} is not an object`);
      continue;
    }
    const game = rawGame as Record<string, unknown>;
    const versionsValue = game.versions;
    if (versionsValue === null || typeof versionsValue !== "object" || Array.isArray(versionsValue)) {
      issues.push(`game ${gameId} has invalid versions`);
      continue;
    }
    const variants: CartridgeVariantInventory[] = [];
    for (const [version, rawVersion] of Object.entries(versionsValue as Record<string, unknown>)) {
      if (rawVersion === null || typeof rawVersion !== "object") {
        issues.push(`version ${gameId}/${version} is not an object`);
        continue;
      }
      const architecturesValue = (rawVersion as Record<string, unknown>).architectures;
      if (architecturesValue === null || typeof architecturesValue !== "object" || Array.isArray(architecturesValue)) {
        issues.push(`version ${gameId}/${version} has invalid architectures`);
        continue;
      }
      for (const [architecture, rawVariant] of Object.entries(architecturesValue as Record<string, unknown>)) {
        if (rawVariant === null || typeof rawVariant !== "object") {
          issues.push(`variant ${gameId}/${version}/${architecture} is not an object`);
          continue;
        }
        const variant = rawVariant as Record<string, unknown>;
        const filename = scalarString(variant.filename, "");
        const candidate = path.resolve(root, filename);
        const pathSafe = Boolean(filename) && isWithin(root, candidate);
        if (!pathSafe) {
          issues.push(`unsafe variant path ${gameId}/${version}/${architecture}`);
        }
        const exists = pathSafe && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        if (pathSafe && !exists) {
          issues.push(`missing variant file ${filename}`);
        }
        let size: number | null = null;
        let sha256: string | null = null;
        if (exists) {
          const bytes = fs.readFileSync(candidate);
          size = bytes.byteLength;
          sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        }
        const expectedSha256 = typeof variant.sha256 === "string" ? variant.sha256 : null;
        variants.push({
          architecture,
          filename,
          pathSafe,
          exists,
          size,
          sha256,
          expectedSha256,
          hashMatches: expectedSha256 === null || sha256 === null ? null : expectedSha256 === sha256
        });
      }
    }
    games.push({
      id: scalarString(game.id, gameId),
      versions: Object.keys(versionsValue).sort(),
      architectures: variants.map((variant) => variant.architecture).sort(),
      variants: variants.sort((left, right) => left.architecture.localeCompare(right.architecture))
    });
  }
  return {
    abi: typeof index.abi === "string" ? index.abi : null,
    indexPresent: true,
    games: games.sort((left, right) => left.id.localeCompare(right.id)),
    issues
  };
}
