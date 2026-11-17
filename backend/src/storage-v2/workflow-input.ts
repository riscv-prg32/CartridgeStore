import type { BackendConfig } from "../config/env.js";
import { SubmissionError } from "../submission/errors.js";
import { parseZipArchive, type ZipEntry } from "../submission/zip.js";
import {
  prepareSubmissionBundle,
  type PreparedSubmissionBundle,
} from "../submission/service.js";

/** Validates and prepares a multipart submission bundle for workflow writes. */
export function prepareCanonicalSubmissionBundle(
  bundle: Uint8Array,
  config: BackendConfig,
): PreparedSubmissionBundle {
  try {
    const entries: Map<string, ZipEntry> = parseZipArchive(bundle, config);
    return prepareSubmissionBundle(entries, config);
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError(
      "bundle could not be validated",
      "invalid_request",
      400,
      { cause: error },
    );
  }
}
