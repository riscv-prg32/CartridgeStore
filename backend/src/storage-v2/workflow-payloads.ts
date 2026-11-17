import {
  buildSubmissionCartridge,
  parseCartridge,
  validateCartridgeBinary,
} from "../submission/prg32.js";
import type { ReviewErrorCode } from "../review/errors.js";
import type { CanonicalObjectPlan } from "./workflow-objects.js";
import {
  reviewedMetadata,
  sha256,
} from "./workflow-codecs.js";

/** Staged artifact data required to materialize a publication payload. */
export interface CanonicalPayloadArtifact {
  readonly architecture: "esp32c6" | "qemu";
  readonly staging_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

/** Journal data required to materialize canonical publication payloads. */
export interface CanonicalPayloadManifest {
  readonly submissionId: number;
  readonly reviewUpdates: Record<string, unknown>;
  readonly objects: readonly CanonicalObjectPlan[];
}

interface PayloadMaterializationDependencies {
  readonly readStaged: (row: CanonicalPayloadArtifact) => Buffer;
  readonly safeMetadata: (value: unknown) => Record<string, unknown>;
  readonly fail: (
    message: string,
    code?: ReviewErrorCode,
    status?: number,
  ) => never;
}

/** Rebuilds and verifies the bytes referenced by a publication manifest. */
export function materializeCanonicalPayloads(
  manifest: CanonicalPayloadManifest,
  artifacts: readonly CanonicalPayloadArtifact[],
  dependencies: PayloadMaterializationDependencies,
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const artifact of artifacts) {
    const source = dependencies.readStaged(artifact);
    const parsed = validateCartridgeBinary(source);
    const originalMetadata = dependencies.safeMetadata(parsed.metadata);
    const updatedMetadata = reviewedMetadata(
      originalMetadata,
      manifest.reviewUpdates,
    );
    const colophon = parsed.colophon
      ? {
          ...parsed.colophon,
          title: updatedMetadata.title,
          version: updatedMetadata.version,
        }
      : null;
    const image = Buffer.from(
      buildSubmissionCartridge(
        parsed.legacyPayload,
        updatedMetadata,
        parsed.icon ?? Buffer.alloc(0),
        artifact.architecture,
        parsed.screenshot,
        colophon,
      ),
    );
    const artifactPlan = manifest.objects.find(
      (item) =>
        item.objectKind === "artifact" &&
        item.architecture === artifact.architecture,
    );
    if (
      !artifactPlan ||
      sha256(image) !== artifactPlan.sha256 ||
      image.byteLength !== artifactPlan.sizeBytes
    ) {
      dependencies.fail(
        "publication artifact plan does not match staged bytes",
        "review_operation_failed",
        500,
      );
    }
    result.set(artifactPlan.objectId, image);
    const rebuilt = parseCartridge(image);
    for (const plan of manifest.objects.filter(
      (item) =>
        item.sourceStagingKey === artifact.staging_key &&
        item.objectKind === "media",
    )) {
      const media =
        plan.targetRole === "icon" ? rebuilt.icon : rebuilt.screenshot;
      if (
        !media ||
        sha256(media) !== plan.sha256 ||
        media.byteLength !== plan.sizeBytes
      ) {
        dependencies.fail(
          "publication media plan does not match staged bytes",
          "review_operation_failed",
          500,
        );
      }
      result.set(plan.objectId, Buffer.from(media));
    }
  }
  return result;
}
