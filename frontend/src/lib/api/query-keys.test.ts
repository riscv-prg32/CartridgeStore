import { describe, expect, test } from "vitest";

import { adminQueryKeys, authQueryKeys, catalogQueryKeys, workflowQueryKeys } from "./query-keys";

describe("domain query-key factories", () => {
  test("keep response-affecting parameters isolated", () => {
    expect(catalogQueryKeys.list({ query: "pong", page: 1 })).not.toEqual(catalogQueryKeys.list({ query: "pong", page: 2 }));
    expect(adminQueryKeys.users({ page: 1, search: "ada" })).not.toEqual(adminQueryKeys.users({ page: 1, search: "grace" }));
    expect(workflowQueryKeys.mine(1, "pending")).not.toEqual(workflowQueryKeys.mine(1, "rejected"));
  });

  test("reuse stable prefixes for intentional partial invalidation", () => {
    expect(authQueryKeys.tokens()).toEqual(["auth", "tokens"]);
    expect(workflowQueryKeys.submissions("pending").slice(0, 2)).toEqual(["workflow", "submissions"]);
  });
});
