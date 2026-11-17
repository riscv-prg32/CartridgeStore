import {
  buildSubmissionCartridge,
  parseCartridge,
  validateCartridgeBinary,
} from "../submission/prg32.js";
import type { ReviewErrorCode } from "../review/errors.js";
import type { CanonicalArtifactRow } from "./workflow-records.js";
import type { CanonicalObjectPlan } from "./workflow-objects.js";
import { mediaType, reviewedMetadata, sha256, uuid } from "./workflow-codecs.js";

/** Prepared metadata, colophon and object identities for publication. */
export interface CanonicalPublicationPlan {
  readonly metadata: Record<string, unknown>;
  readonly colophon: Record<string, unknown> | null;
  readonly objects: readonly CanonicalObjectPlan[];
}

interface PublicationPlanOptions {
  readonly artifacts: readonly CanonicalArtifactRow[];
  readonly metadataUpdates: Record<string, unknown>;
  readonly readStaged: (row: CanonicalArtifactRow) => Buffer;
  readonly safeMetadata: (value: unknown) => Record<string, unknown>;
  readonly fail: (
    message: string,
    code?: ReviewErrorCode,
    status?: number,
  ) => never;
}

/** Rebuilds staged artifacts and derives the canonical publication objects. */
export function buildCanonicalPublicationPlan(
  options: PublicationPlanOptions,
): CanonicalPublicationPlan {
  const first = options.artifacts[0];
  if (!first) {
    options.fail("submission has no artifacts", "review_operation_failed", 500);
  }

  const firstParsed = validateCartridgeBinary(options.readStaged(first));
  const reviewed = reviewedMetadata(
    options.safeMetadata(firstParsed.metadata),
    options.metadataUpdates,
  );
  const objects: CanonicalObjectPlan[] = [];

  for (const artifact of options.artifacts) {
    const artifactId = uuid("artifact");
    const parsed = validateCartridgeBinary(options.readStaged(artifact));
    const updatedMetadata = reviewedMetadata(
      options.safeMetadata(parsed.metadata),
      options.metadataUpdates,
    );
    const reviewedColophon = parsed.colophon
      ? {
          ...parsed.colophon,
          title: updatedMetadata.title,
          version: updatedMetadata.version,
        }
      : null;
    const rebuilt = Buffer.from(
      buildSubmissionCartridge(
        parsed.legacyPayload,
        updatedMetadata,
        parsed.icon ?? Buffer.alloc(0),
        artifact.architecture,
        parsed.screenshot,
        reviewedColophon,
      ),
    );

    objects.push({
      objectId: uuid("obj"),
      objectKind: "artifact",
      targetRole: "artifact",
      architecture: artifact.architecture,
      mediaType: artifact.media_type,
      sha256: sha256(rebuilt),
      sizeBytes: rebuilt.byteLength,
      sourceStagingKey: artifact.staging_key,
      artifactId,
      mediaId: null,
    });

    const rebuiltParsed = parseCartridge(rebuilt);
    const mediaEntries: Array<{
      role: "icon" | "screenshot";
      bytes: Uint8Array;
    }> = [
      { role: "icon", bytes: rebuiltParsed.icon ?? new Uint8Array() },
    ];
    if (rebuiltParsed.screenshot) {
      mediaEntries.push({
        role: "screenshot",
        bytes: rebuiltParsed.screenshot,
      });
    }

    for (const media of mediaEntries) {
      if (media.bytes.byteLength === 0) {
        options.fail("submission media is missing", "review_operation_failed", 500);
      }
      objects.push({
        objectId: uuid("obj"),
        objectKind: "media",
        targetRole: media.role,
        architecture: artifact.architecture,
        mediaType: mediaType(media.bytes),
        sha256: sha256(media.bytes),
        sizeBytes: media.bytes.byteLength,
        sourceStagingKey: artifact.staging_key,
        artifactId,
        mediaId: uuid("media"),
      });
    }
  }

  return {
    metadata: reviewed,
    colophon: firstParsed.colophon
      ? {
          ...firstParsed.colophon,
          title: reviewed.title,
          version: reviewed.version,
        }
      : null,
    objects,
  };
}
