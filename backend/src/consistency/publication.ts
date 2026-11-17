import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { safeGameId, safeVersion } from "../catalog/catalog.js";
import {
  normalizeArchitecture,
  validateCartridgeBinary,
  type parseCartridge,
} from "../submission/prg32.js";
import {
  applyReviewMetadata,
  catalogColophon,
  fail,
  imageMime,
  isoNow,
  object,
  parseArchitectures,
  parseObjectJson,
  parseOperation,
  reviewedImage,
  serializeJson,
  sha256,
} from "./publication-codecs.js";
import {
  type CatalogMutationAction,
  type CatalogMutationOptions,
  type FaultPoint,
  type PublicationConsistencyOptions,
  type PublicationOperation,
  type PublicationReviewOptions,
  type PublicationState,
  type PublicationVariantPlan,
  type ReconciliationReport,
} from "./publication-contracts.js";
import {
  assertInside,
  assertNoSymlinkComponents,
  assertSafeRelative,
  ensureDirectory,
  listDirectories,
  readBounded,
  readJsonFile,
  sha256File,
  withPublicationLock,
  writeAtomic
} from "./publication-files.js";
import { reconcilePublication } from "./reconciliation.js";
import {
  indexForCatalogMutation,
  indexForPublication,
  loadPublicationIndex,
} from "./publication-index.js";
import {
  PUBLICATION_MAX_CARTRIDGE_BYTES,
  PUBLICATION_PENDING_ROOT,
  PUBLICATION_STAGING_ROOT,
  PublicationExecutionService,
} from "./publication-execution.js";

export { applyReviewMetadata } from "./publication-codecs.js";
export {
  PUBLICATION_STATES,
  REVIEW_EDITABLE_METADATA_FIELDS,
} from "./publication-contracts.js";
export type {
  CatalogMutationAction,
  CatalogMutationOptions,
  FaultPoint,
  PublicationConsistencyOptions,
  PublicationOperation,
  PublicationOperationKind,
  PublicationReviewOptions,
  PublicationState,
  PublicationVariantPlan,
  ReconciliationClassification,
  ReconciliationFinding,
  ReconciliationReport,
} from "./publication-contracts.js";

interface SubmissionRow {
  readonly id: number;
  readonly game_id: string;
  readonly version: string;
  readonly status: string;
  readonly pending_dir: string;
  readonly metadata_json: string;
  readonly architectures_json: string;
}

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const LOCK_FILE = "publication.lock";
const JOURNAL_ROOT = "publication-operations";
const BACKUP_ROOT = "publication-backups";
const CARTRIDGE_ROOT = "cartridges";

export class PublicationConsistencyService {
  readonly root: string;
  private readonly database: Database.Database;
  private readonly journalRoot: string;
  private readonly stagingRoot: string;
  private readonly backupRoot: string;
  private readonly lockPath: string;
  private readonly executor: PublicationExecutionService;

  constructor(options: PublicationConsistencyOptions) {
    this.root = path.resolve(options.root);
    this.database = options.database;
    if (!fs.existsSync(this.root) || !fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) fail("publication root must be a regular directory", "unsafe_publication_root");
    this.journalRoot = ensureDirectory(this.root, JOURNAL_ROOT);
    this.stagingRoot = ensureDirectory(this.root, PUBLICATION_STAGING_ROOT);
    this.backupRoot = ensureDirectory(this.root, BACKUP_ROOT);
    this.lockPath = path.join(this.root, LOCK_FILE);
    this.fault = options.fault;
    this.executor = new PublicationExecutionService({
      root: this.root,
      database: this.database,
      ...(this.fault ? { fault: this.fault } : {}),
      transition: (operation, state, error) =>
        this.transition(operation, state, error),
    });
  }

  private readonly fault: ((point: FaultPoint) => void) | undefined;

  private hit(point: FaultPoint): void { this.fault?.(point); }

  private operationPath(operationId: string): string {
    if (!/^pub-[a-f0-9-]{16,80}$/.test(operationId)) fail("operation ID is unsafe", "unsafe_publication_path");
    return path.join(JOURNAL_ROOT, operationId, "operation.json");
  }

  private readOperation(operationId: string): PublicationOperation {
    return parseOperation(readJsonFile(this.root, this.operationPath(operationId), MAX_JOURNAL_BYTES, "journal_corrupt"));
  }

  private writeOperation(operation: PublicationOperation): PublicationOperation {
    const updated = { ...operation, updatedAt: isoNow() } as PublicationOperation;
    writeAtomic(this.root, this.operationPath(operation.operationId), serializeJson(updated));
    return updated;
  }

  private transition(operation: PublicationOperation, state: PublicationState, error?: { code: string; message: string }): PublicationOperation {
    const next = { ...operation, state, ...(error ? { error } : {}) } as PublicationOperation;
    return this.writeOperation(next);
  }

  private withLock<T>(callback: () => T): T { return withPublicationLock(this.lockPath, callback); }

  private pendingRow(submissionId: number): SubmissionRow {
    const row = this.database.prepare("SELECT id, game_id, version, status, pending_dir, metadata_json, architectures_json FROM cartridge_submissions WHERE id = ?").get(submissionId) as SubmissionRow | undefined;
    if (!row) fail("submission not found", "submission_not_found");
    return row;
  }

  prepare(submissionId: number, options: PublicationReviewOptions = {}): PublicationOperation {
    return this.withLock(() => this.prepareUnlocked(submissionId, options));
  }

  publish(submissionId: number, options: PublicationReviewOptions = {}): PublicationOperation {
    return this.withLock(() =>
      this.executor.execute(this.prepareUnlocked(submissionId, options)),
    );
  }

  prepareCatalog(options: CatalogMutationOptions): PublicationOperation {
    return this.withLock(() => this.prepareCatalogUnlocked(options));
  }

  mutateCatalog(options: CatalogMutationOptions): PublicationOperation {
    return this.withLock(() =>
      this.executor.execute(this.prepareCatalogUnlocked(options)),
    );
  }

  runSerialized<T>(callback: () => T): T {
    return this.withLock(callback);
  }

  private prepareUnlocked(submissionId: number, options: PublicationReviewOptions): PublicationOperation {
      const row = this.pendingRow(submissionId);
      if (row.status !== "pending") fail("submission is not pending", "invalid_submission_state");
      const metadata = parseObjectJson(row.metadata_json, "submission metadata");
      const reviewedMetadata = options.metadata ? applyReviewMetadata(metadata, options.metadata) : undefined;
      if (options.reviewer && (!Number.isSafeInteger(options.reviewer.id) || options.reviewer.id <= 0 || !options.reviewer.name.trim())) {
        fail("reviewer identity is invalid", "review_authorization_invalid");
      }
      const metadataId = typeof metadata.id === "string" ? metadata.id : row.game_id;
      const metadataVersion = typeof metadata.version === "string" ? metadata.version : row.version;
      const gameId = safeGameId(metadataId);
      const version = safeVersion(metadataVersion);
      if (gameId !== row.game_id || version !== row.version) fail("submission identity does not match metadata", "submission_identity_mismatch");
      const pendingDir = assertSafeRelative(row.pending_dir, "pending directory");
      if (pendingDir !== `${PUBLICATION_PENDING_ROOT}/${submissionId}`) fail("submission pending directory is unsafe", "unsafe_publication_path");
      const architectures = parseArchitectures(row.architectures_json);
      if (architectures.length === 0) fail("submission has no architectures", "submission_metadata_corrupt");
      const seen = new Set<string>();
      const indexSource: Array<{ architecture: string; sourceRelative: string; image: Buffer; parsed: ReturnType<typeof parseCartridge> }> = [];
      for (const item of architectures) {
        const architecture = typeof item.architecture === "string" ? item.architecture : "";
        if (!architecture || seen.has(architecture)) fail("submission contains duplicate architectures", "submission_metadata_corrupt");
        seen.add(architecture);
        const sourceRelative = assertSafeRelative(typeof item.stored === "string" ? item.stored : "", "pending file");
        if (!sourceRelative.startsWith(`${pendingDir}/`) || !sourceRelative.endsWith(`/${architecture}.prg32`)) fail("pending file does not match the submission", "unsafe_publication_path");
        const sourcePath = assertInside(this.root, path.join(this.root, sourceRelative), "pending file");
        assertNoSymlinkComponents(this.root, sourcePath);
        if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) fail("pending cartridge file is missing", "pending_file_missing", { sourceRelative });
        const pendingImage = readBounded(sourcePath, PUBLICATION_MAX_CARTRIDGE_BYTES, "pending_file_too_large");
        const rebuilt = reviewedImage(pendingImage, architecture, reviewedMetadata);
        const image = rebuilt.image;
        const parsed = rebuilt.parsed;
        if (!parsed.metadata || parsed.metadata.id !== gameId || parsed.metadata.version !== version) fail("pending cartridge metadata does not match submission", "submission_identity_mismatch");
        indexSource.push({ architecture, sourceRelative, image, parsed });
      }
      this.hit("after-pending-validation");
      const loaded = loadPublicationIndex(this.root);
      const operationId = `pub-${crypto.randomUUID()}`;
      const createdAt = isoNow();
      const variants: PublicationVariantPlan[] = indexSource.map(({ architecture, sourceRelative, image, parsed }) => {
        const targetRelative = `${CARTRIDGE_ROOT}/${gameId}/${version}/${architecture}.prg32`;
        const backupRelative = `${BACKUP_ROOT}/${operationId}/${targetRelative}`;
        const targetPath = assertInside(this.root, path.join(this.root, targetRelative), "published file");
        let previousSha256: string | null = null;
        if (fs.existsSync(targetPath)) {
          assertNoSymlinkComponents(this.root, targetPath);
          if (!fs.lstatSync(targetPath).isFile()) fail("published target is not a regular file", "published_artifact_corrupt");
          previousSha256 = sha256File(targetPath);
        }
        return {
          architecture,
          sourceRelative,
          targetRelative,
          stagedRelative: `${PUBLICATION_STAGING_ROOT}/${operationId}/${targetRelative}`,
          backupRelative,
          expectedSha256: sha256(image),
          previousSha256,
          size: image.byteLength,
          metadata: parsed.metadata as Record<string, unknown>,
          colophon: parsed.colophon,
          iconMime: imageMime(parsed.icon),
          screenshotMime: imageMime(parsed.screenshot),
          hasScreenshot: parsed.screenshot !== null,
          hasSignature: parsed.blocks.some((block) => block.type === "SIGN")
        };
      });
      const expectedIndex = indexForPublication(
        loaded.index,
        gameId,
        version,
        variants,
        createdAt,
      );
      const expectedIndexBytes = serializeJson(expectedIndex);
      const operation: PublicationOperation = {
        journalVersion: 1,
        operationId,
        submissionId,
        gameId,
        version,
        variants,
        previousIndexSha256: loaded.hash,
        expectedIndexSha256: sha256(expectedIndexBytes),
        indexStagedRelative: `${PUBLICATION_STAGING_ROOT}/${operationId}/index.json`,
        indexBackupRelative: `${BACKUP_ROOT}/${operationId}/index.json`,
        state: "PREPARED",
        createdAt,
        updatedAt: createdAt,
        ...(reviewedMetadata ? { reviewedMetadata } : {}),
        ...(options.reviewer ? { reviewer: { id: options.reviewer.id, name: options.reviewer.name.trim() } } : {})
      };
      const written = this.writeOperation(operation);
      this.hit("after-operation-record");
      return written;
  }

  private prepareCatalogUnlocked(options: CatalogMutationOptions): PublicationOperation {
    const gameId = safeGameId(options.gameId);
    const version = safeVersion(options.version);
    const loaded = loadPublicationIndex(this.root);
    const games = object(loaded.index.games, "catalog index games is malformed");
    if (!Object.hasOwn(games, gameId)) fail("game not found", "catalog_not_found");
    const game = object(games[gameId], "game not found");
    const versions = object(game.versions, "catalog versions are malformed");
    if (!Object.hasOwn(versions, version)) fail("version not found", "catalog_not_found");
    const currentVersion = object(versions[version], "version not found");
    const architectures = object(currentVersion.architectures, "catalog architectures are malformed");
    const selected = options.architecture === undefined
      ? Object.keys(architectures).sort()
      : [normalizeArchitecture(options.architecture)];
    if (selected.length === 0) fail("version has no published architectures", "catalog_not_found");
    const operationId = `pub-${crypto.randomUUID()}`;
    const action: CatalogMutationAction = options.metadata === undefined ? "delete" : "update";
    const reviewedMetadata = action === "update"
      ? applyReviewMetadata(object(currentVersion.metadata, "catalog metadata is malformed"), options.metadata as Record<string, unknown>)
      : undefined;
    const variants: PublicationVariantPlan[] = [];
    for (const architecture of selected) {
      const rawVariant = architectures[architecture];
      const variant = object(rawVariant, "catalog variant is malformed");
      const filename = typeof variant.filename === "string" ? assertSafeRelative(variant.filename, "catalog file") : "";
      if (!filename.startsWith(`${CARTRIDGE_ROOT}/`)) fail("catalog file is outside the published root", "unsafe_publication_path");
      const target = assertInside(this.root, path.join(this.root, filename), "published file");
      assertNoSymlinkComponents(this.root, target);
      const stats = fs.lstatSync(target);
      if (!stats.isFile()) fail("published artifact is not a regular file", "published_artifact_corrupt");
      const source = readBounded(target, PUBLICATION_MAX_CARTRIDGE_BYTES, "published_file_corrupt");
      const original = validateCartridgeBinary(source);
      const image = action === "update"
        ? reviewedImage(source, architecture, reviewedMetadata, catalogColophon(original.colophon, reviewedMetadata as Record<string, unknown>))
        : { image: Buffer.from(source), parsed: original };
      variants.push({
        architecture,
        sourceRelative: filename,
        targetRelative: filename,
        stagedRelative: `${PUBLICATION_STAGING_ROOT}/${operationId}/${filename}`,
        backupRelative: `${BACKUP_ROOT}/${operationId}/${filename}`,
        expectedSha256: action === "update" ? sha256(image.image) : "",
        previousSha256: sha256(source),
        size: action === "update" ? image.image.byteLength : source.byteLength,
        metadata: (action === "update" ? image.parsed.metadata : original.metadata) ?? {},
        colophon: action === "update" ? image.parsed.colophon : original.colophon,
        iconMime: imageMime(image.parsed.icon),
        screenshotMime: imageMime(image.parsed.screenshot),
        hasScreenshot: image.parsed.screenshot !== null,
        hasSignature: image.parsed.blocks.some((block) => block.type === "SIGN")
      });
    }
    const createdAt = isoNow();
    const expectedIndex = indexForCatalogMutation(
      loaded.index,
      gameId,
      version,
      variants,
      action,
      createdAt,
    );
    const expectedIndexBytes = serializeJson(expectedIndex);
    const operation: PublicationOperation = {
      journalVersion: 1,
      operationKind: "catalog",
      catalogAction: action,
      operationId,
      submissionId: 0,
      gameId,
      version,
      variants,
      previousIndexSha256: loaded.hash,
      expectedIndexSha256: sha256(expectedIndexBytes),
      indexStagedRelative: `${PUBLICATION_STAGING_ROOT}/${operationId}/index.json`,
      indexBackupRelative: `${BACKUP_ROOT}/${operationId}/index.json`,
      state: "PREPARED",
      createdAt,
      updatedAt: createdAt,
      ...(reviewedMetadata ? { reviewedMetadata } : {})
    };
    const written = this.writeOperation(operation);
    this.hit("after-operation-record");
    return written;
  }

  stage(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.stage(this.readOperation(operationId)),
    );
  }

  verifyStaged(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.verifyStaged(this.readOperation(operationId)),
    );
  }

  replaceFiles(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.replaceFiles(this.readOperation(operationId)),
    );
  }

  replaceIndex(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.replaceIndex(this.readOperation(operationId)),
    );
  }

  updateDatabase(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.updateDatabase(this.readOperation(operationId)),
    );
  }

  complete(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.complete(this.readOperation(operationId)),
    );
  }

  execute(operationId: string): PublicationOperation {
    return this.withLock(() =>
      this.executor.execute(this.readOperation(operationId)),
    );
  }

  recover(operationId: string, action: "resume" | "compensate"): PublicationOperation {
    return this.withLock(() =>
      this.executor.recover(this.readOperation(operationId), action),
    );
  }

  listOperations(): PublicationOperation[] {
    return listDirectories(this.root, JOURNAL_ROOT).map((operationId) => this.readOperation(operationId));
  }

  reconcile(): ReconciliationReport {
    return reconcilePublication({
      root: this.root,
      database: this.database,
      loadIndex: () => loadPublicationIndex(this.root).index,
      readOperation: (operationId) => this.readOperation(operationId),
    });
  }
}
