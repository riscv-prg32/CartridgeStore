import Database from "better-sqlite3";

import { PublicationConsistencyService } from "../../src/consistency/publication.js";
import { ReviewService } from "../../src/review/service.js";

const root = process.env.PRG32_TEST_ROOT;
const databasePath = process.env.PRG32_TEST_DATABASE;
const submission = Number(process.env.PRG32_TEST_SUBMISSION);
const mode = process.env.PRG32_TEST_MODE;
if (!root || !databasePath || !Number.isSafeInteger(submission) || (mode !== "approve" && mode !== "reject")) process.exit(2);

const database = new Database(databasePath);
const publication = new PublicationConsistencyService({
  root,
  database,
  fault: (point) => {
    if (mode === "approve" && point === "after-index-replacement") process.kill(process.pid, "SIGKILL");
  }
});
const review = new ReviewService({
  root,
  database,
  publication,
  fault: (point) => {
    if (mode === "reject" && point === "after-rejection-database-update") process.kill(process.pid, "SIGKILL");
  }
});
const principal = { authenticated: true, id: 1, name: "editor", username: "editor", email: "editor@example.test", role: "admin" as const, groups: ["editors"], authMethod: "session" as const };
if (mode === "approve") review.approve(submission, { title: "Crash Approved" }, principal);
else review.reject(submission, principal);
