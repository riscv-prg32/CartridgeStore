import Database from "better-sqlite3";

import { PublicationConsistencyService } from "../../src/consistency/publication.js";

const root = process.env.PRG32_TEST_ROOT;
const databasePath = process.env.PRG32_TEST_DATABASE;
const killPoint = process.env.PRG32_TEST_KILL_POINT;
if (!root || !databasePath || !killPoint) process.exit(2);

const database = new Database(databasePath);
const service = new PublicationConsistencyService({
  root,
  database,
  fault: (point) => {
    if (point === killPoint) process.kill(process.pid, "SIGKILL");
  }
});

const operation = service.prepare(1);
service.execute(operation.operationId);
database.close();
