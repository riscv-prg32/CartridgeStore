import fs from "node:fs";
import path from "node:path";

import { INDEX_ABI } from "../catalog/catalog.js";
import { readBounded } from "./publication-files.js";
import {
  clone,
  fail,
  isoNow,
  object,
  sha256,
} from "./publication-codecs.js";
import type {
  CatalogMutationAction,
  PublicationVariantPlan,
} from "./publication-contracts.js";

/** Maximum accepted catalog index size. */
export const PUBLICATION_INDEX_MAX_BYTES = 16 * 1024 * 1024;

/** Loaded catalog index and the digest used by publication concurrency checks. */
export interface PublicationIndexSnapshot {
  readonly index: Record<string, unknown>;
  readonly hash: string | null;
}

/** Reads and validates the catalog index used by publication operations. */
export function loadPublicationIndex(root: string): PublicationIndexSnapshot {
  const indexPath = path.join(root, "index.json");
  if (!fs.existsSync(indexPath)) {
    return {
      index: {
        abi: INDEX_ABI,
        updated_at: isoNow(),
        games: {},
      },
      hash: null,
    };
  }
  const bytes = readBounded(
    indexPath,
    PUBLICATION_INDEX_MAX_BYTES,
    "index_corrupt",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail("catalog index is malformed", "index_corrupt");
  }
  const index = object(parsed, "catalog index is malformed");
  if (index.abi !== undefined && index.abi !== INDEX_ABI) {
    fail("catalog index ABI is unsupported", "index_corrupt");
  }
  if (
    index.games === null ||
    typeof index.games !== "object" ||
    Array.isArray(index.games)
  ) {
    fail("catalog index games is malformed", "index_corrupt");
  }
  return {
    index: clone(index),
    hash: sha256(bytes),
  };
}

/** Builds the catalog projection for a submission publication operation. */
export function indexForPublication(
  index: Record<string, unknown>,
  gameId: string,
  version: string,
  variants: readonly PublicationVariantPlan[],
  updatedAt: string,
): Record<string, unknown> {
  const next = clone(index);
  next.abi = INDEX_ABI;
  next.updated_at = updatedAt;
  const games = object(next.games ?? {}, "catalog index games is malformed");
  const currentGame = object(
    games[gameId] ?? {
      id: gameId,
      created_at: next.updated_at,
      versions: {},
    },
    "catalog game is malformed",
  );
  const versions = object(
    currentGame.versions ?? {},
    "catalog versions are malformed",
  );
  const currentVersion = object(
    versions[version] ?? {
      version,
      published_at: next.updated_at,
      architectures: {},
    },
    "catalog version is malformed",
  );
  const architectures = object(
    currentVersion.architectures ?? {},
    "catalog architectures are malformed",
  );
  const first = variants[0];
  if (!first) fail("publication has no variants", "submission_metadata_corrupt");
  const metadata = first.metadata;
  currentGame.id = gameId;
  currentGame.title = metadata.title;
  currentGame.summary =
    typeof metadata.summary === "string" ? metadata.summary : "";
  currentGame.authors = Array.isArray(metadata.authors)
    ? metadata.authors
    : [];
  currentGame.tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  currentGame.latest_version = version;
  currentGame.updated_at = next.updated_at;
  for (const variant of variants) {
    const previous = object(
      architectures[variant.architecture] ?? {},
      "catalog variant is malformed",
    );
    architectures[variant.architecture] = {
      ...previous,
      architecture: variant.architecture,
      filename: variant.targetRelative,
      size: variant.size,
      sha256: variant.expectedSha256,
      icon_mime: variant.iconMime,
      screenshot_mime: variant.screenshotMime,
      has_screenshot: variant.hasScreenshot,
      has_signature: variant.hasSignature,
      updated_at: next.updated_at,
    };
  }
  currentVersion.version = version;
  currentVersion.updated_at = next.updated_at;
  currentVersion.metadata = metadata;
  currentVersion.colophon = first.colophon;
  currentVersion.architectures = architectures;
  versions[version] = currentVersion;
  currentGame.versions = versions;
  games[gameId] = currentGame;
  next.games = games;
  return next;
}

/** Builds the catalog projection for an update or deletion operation. */
export function indexForCatalogMutation(
  index: Record<string, unknown>,
  gameId: string,
  version: string,
  variants: readonly PublicationVariantPlan[],
  action: CatalogMutationAction,
  updatedAt: string,
): Record<string, unknown> {
  const next = clone(index);
  next.abi = INDEX_ABI;
  next.updated_at = updatedAt;
  const games = object(next.games, "catalog index games is malformed");
  const game = object(games[gameId], "game not found");
  const versions = object(game.versions, "catalog versions are malformed");
  const versionRecord = object(versions[version], "version not found");
  const architectures = object(
    versionRecord.architectures,
    "catalog architectures are malformed",
  );
  if (action === "delete") {
    for (const variant of variants) delete architectures[variant.architecture];
    if (Object.keys(architectures).length === 0) delete versions[version];
    else versionRecord.architectures = architectures;
    if (Object.keys(versions).length === 0) delete games[gameId];
    else {
      if (
        game.latest_version === version &&
        !Object.hasOwn(versions, version)
      ) {
        game.latest_version = Object.keys(versions).sort().at(-1);
      }
      game.updated_at = updatedAt;
    }
    next.games = games;
    return next;
  }
  const first = variants[0];
  if (!first?.metadata) fail("catalog metadata is unavailable", "catalog_inconsistent");
  const metadata = first.metadata;
  game.title = metadata.title;
  game.summary = typeof metadata.summary === "string" ? metadata.summary : "";
  game.authors = Array.isArray(metadata.authors) ? metadata.authors : [];
  game.tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  game.updated_at = updatedAt;
  for (const variant of variants) {
    const previous = object(
      architectures[variant.architecture],
      "catalog variant is malformed",
    );
    architectures[variant.architecture] = {
      ...previous,
      architecture: variant.architecture,
      filename: variant.targetRelative,
      size: variant.size,
      sha256: variant.expectedSha256,
      icon_mime: variant.iconMime,
      screenshot_mime: variant.screenshotMime,
      has_screenshot: variant.hasScreenshot,
      has_signature: variant.hasSignature,
      updated_at: updatedAt,
    };
  }
  versionRecord.metadata = metadata;
  versionRecord.colophon = first.colophon;
  versionRecord.architectures = architectures;
  versionRecord.updated_at = updatedAt;
  versions[version] = versionRecord;
  game.versions = versions;
  games[gameId] = game;
  next.games = games;
  return next;
}
