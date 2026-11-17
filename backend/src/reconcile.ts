import Database from "better-sqlite3";

import { loadConfig } from "./config/env.js";
import { PublicationConsistencyError } from "./consistency/errors.js";
import { PublicationConsistencyService } from "./consistency/publication.js";
import { ReviewService } from "./review/service.js";

function combinedStatus(findings: readonly { classification: string }[]): "CONSISTENT" | "RECOVERABLE" | "AMBIGUOUS" | "CORRUPT" {
  if (findings.length === 0) return "CONSISTENT";
  if (findings.some((finding) => finding.classification === "CORRUPT")) return "CORRUPT";
  if (findings.some((finding) => finding.classification === "AMBIGUOUS")) return "AMBIGUOUS";
  return "RECOVERABLE";
}

const args = new Set(process.argv.slice(2));
if (!args.has("--check")) {
  console.error("usage: pnpm reconcile --check");
  process.exitCode = 2;
} else {
  try {
    const config = loadConfig();
    if (!config.submissionWriteEnabled || !config.submissionDisposableRoot || !config.authWriteDatabasePath || config.submissionWriteMode !== "test") {
      throw new PublicationConsistencyError("reconciliation requires the disposable writer profile", "reconciliation_unavailable");
    }
    const database = new Database(config.authWriteDatabasePath, { readonly: true, fileMustExist: true });
    try {
      const publicationReport = new PublicationConsistencyService({ root: config.submissionDisposableRoot, database }).reconcile();
      const reviewFindings = new ReviewService({ root: config.submissionDisposableRoot, database, maxSubmissions: config.reviewMaxSubmissions }).reconcile();
      const findings = [...publicationReport.findings, ...reviewFindings];
      const report = { ...publicationReport, status: combinedStatus(findings), findings, counts: findings.reduce<Record<string, number>>((counts, finding) => { counts[finding.classification] = (counts[finding.classification] ?? 0) + 1; return counts; }, {}) };
      console.log(JSON.stringify(report, null, 2));
      console.error(`Reconciliation: ${report.status}; findings=${report.findings.length}`);
      process.exitCode = report.status === "CONSISTENT" || report.status === "RECOVERABLE" ? 0 : 1;
    } finally {
      database.close();
    }
  } catch (error) {
    const message = error instanceof PublicationConsistencyError ? `${error.code}: ${error.message}` : "reconciliation failed";
    console.error(message);
    process.exitCode = 1;
  }
}
