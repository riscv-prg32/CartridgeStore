import crypto from "node:crypto";

import type Database from "better-sqlite3";

import { readStorageObjectRow, StorageObjectError } from "./objects.js";
import { SUPPORTED_ARCHITECTURES, type Architecture, type ObjectKind } from "./types.js";

export class StorageRelationshipError extends Error {
  readonly code: string;

  constructor(message: string, code = "storage_relationship_invalid", options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageRelationshipError";
    this.code = code;
  }
}

function identifier(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertObjectKind(sqlite: Database.Database, objectId: string, expected: ObjectKind): void {
  const row = readStorageObjectRow(sqlite, objectId);
  if (!row) throw new StorageRelationshipError("referenced storage object does not exist", "relationship_object_missing");
  if (row.objectKind !== expected) throw new StorageRelationshipError("referenced storage object kind is invalid", "relationship_object_kind_mismatch");
  if (row.state !== "available" && row.state !== "staged") throw new StorageRelationshipError("referenced storage object is not promotable", "relationship_object_unavailable");
}

function assertArchitecture(value: string): asserts value is Architecture {
  if (!SUPPORTED_ARCHITECTURES.includes(value as Architecture)) throw new StorageRelationshipError("architecture is invalid", "relationship_architecture_invalid");
}

export interface ArtifactRelationshipInput {
  readonly artifactId?: string;
  readonly releaseId: string;
  readonly architecture: Architecture;
  readonly objectId: string;
  readonly compatibilityJson?: string;
  readonly state?: "staged" | "published" | "superseded" | "withdrawn";
  readonly createdAt?: string;
}

export interface MediaRelationshipInput {
  readonly mediaId?: string;
  readonly releaseId: string;
  readonly architecture: "" | Architecture;
  readonly kind: "icon" | "screenshot";
  readonly objectId: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly createdAt?: string;
}

export interface SiteAssetRelationshipInput {
  readonly assetId?: string;
  readonly assetKey: string;
  readonly objectId: string;
  readonly state?: "active" | "retired";
  readonly createdAt?: string;
  readonly createdByUserId?: number | null;
}

export interface PublicationItemInput {
  readonly operationItemId?: string;
  readonly operationId: string;
  readonly itemKind: "artifact" | "media" | "site_asset";
  readonly architecture?: "" | Architecture;
  readonly targetRole: "artifact" | "icon" | "screenshot" | "site_asset";
  readonly expectedObjectId: string;
  readonly sourceStagingKey?: string | null;
  readonly targetStorageKey: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
  readonly state?: "planned" | "staged" | "verified" | "committed" | "quarantined";
}

function isoNow(value: string | undefined): string {
  return value ?? new Date().toISOString();
}

export class StorageRelationshipService {
  constructor(private readonly sqlite: Database.Database) {}

  createArtifact(input: ArtifactRelationshipInput): string {
    assertArchitecture(input.architecture);
    assertObjectKind(this.sqlite, input.objectId, "artifact");
    const artifactId = input.artifactId ?? identifier("artifact");
    this.sqlite.prepare(
      `INSERT INTO artifacts(artifact_id, release_id, architecture, object_id, compatibility_json, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(artifactId, input.releaseId, input.architecture, input.objectId, input.compatibilityJson ?? "{}", input.state ?? "staged", isoNow(input.createdAt));
    return artifactId;
  }

  createMedia(input: MediaRelationshipInput): string {
    if (input.architecture !== "") assertArchitecture(input.architecture);
    assertObjectKind(this.sqlite, input.objectId, "media");
    const mediaId = input.mediaId ?? identifier("media");
    this.sqlite.prepare(
      `INSERT INTO media(media_id, release_id, architecture, kind, object_id, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(mediaId, input.releaseId, input.architecture, input.kind, input.objectId, input.width ?? null, input.height ?? null, isoNow(input.createdAt));
    return mediaId;
  }

  createSiteAsset(input: SiteAssetRelationshipInput): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.assetKey)) {
      throw new StorageRelationshipError("site asset key is invalid", "relationship_asset_key_invalid");
    }
    assertObjectKind(this.sqlite, input.objectId, "site_asset");
    const assetId = input.assetId ?? identifier("asset");
    this.sqlite.prepare(
      `INSERT INTO site_assets(asset_id, asset_key, object_id, state, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(assetId, input.assetKey, input.objectId, input.state ?? "active", isoNow(input.createdAt), input.createdByUserId ?? null);
    return assetId;
  }

  createPublicationItem(input: PublicationItemInput): string {
    const object = readStorageObjectRow(this.sqlite, input.expectedObjectId);
    if (!object) throw new StorageRelationshipError("publication object does not exist", "publication_object_missing");
    if (input.itemKind !== object.objectKind) throw new StorageRelationshipError("publication item kind does not match object kind", "publication_object_kind_mismatch");
    if (!/^[a-f0-9]{64}$/u.test(input.expectedSha256)) throw new StorageRelationshipError("publication hash is invalid", "publication_hash_invalid");
    if (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 0) throw new StorageRelationshipError("publication size is invalid", "publication_size_invalid");
    if (object.sha256 !== input.expectedSha256 || object.sizeBytes !== input.expectedSizeBytes) {
      throw new StorageRelationshipError("publication object integrity metadata does not match", "publication_integrity_mismatch");
    }
    const architecture = input.architecture ?? "";
    if (input.itemKind === "artifact") {
      if (architecture === "" || input.targetRole !== "artifact") throw new StorageRelationshipError("artifact publication item role is invalid", "publication_role_invalid");
      assertArchitecture(architecture);
    } else if (input.itemKind === "media") {
      if (input.targetRole !== "icon" && input.targetRole !== "screenshot") throw new StorageRelationshipError("media publication item role is invalid", "publication_role_invalid");
      if (architecture !== "") assertArchitecture(architecture);
    } else if (architecture !== "" || input.targetRole !== "site_asset") {
      throw new StorageRelationshipError("site asset publication item role is invalid", "publication_role_invalid");
    }
    const itemId = input.operationItemId ?? identifier("publication-item");
    try {
      this.sqlite.prepare(
        `INSERT INTO publication_operation_items(
          operation_item_id, operation_id, item_kind, architecture, target_role,
          expected_object_id, source_staging_key, target_storage_key,
          expected_sha256, expected_size_bytes, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        itemId,
        input.operationId,
        input.itemKind,
        architecture,
        input.targetRole,
        input.expectedObjectId,
        input.sourceStagingKey ?? null,
        input.targetStorageKey,
        input.expectedSha256,
        input.expectedSizeBytes,
        input.state ?? "planned"
      );
    } catch (error) {
      throw new StorageRelationshipError("publication object is already present in this operation", "publication_item_duplicate", { cause: error });
    }
    return itemId;
  }
}

export function relationshipObjectKind(sqlite: Database.Database, objectId: string): ObjectKind | null {
  try {
    return readStorageObjectRow(sqlite, objectId)?.objectKind ?? null;
  } catch (error) {
    if (error instanceof StorageObjectError) return null;
    throw error;
  }
}
