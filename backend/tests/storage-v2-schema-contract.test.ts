import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compareDocumentedTargetSchema } from "../src/storage-v2/schema-contract.js";

describe("documented target schema contract", () => {
  it("executes documented DDL and matches the executable target schema", () => {
    const markdown = fs.readFileSync(
      path.resolve(process.cwd(), "../docs/storage-schema.md"),
      "utf8",
    );
    expect(compareDocumentedTargetSchema(markdown)).toEqual([]);
  });
});
