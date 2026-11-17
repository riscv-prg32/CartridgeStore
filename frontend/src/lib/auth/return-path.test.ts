import { describe, expect, test } from "vitest";

import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  test("accepts local paths with query strings", () => {
    expect(safeReturnPath("/dashboard/account?tab=profile")).toBe("/dashboard/account?tab=profile");
  });

  test("rejects external and protocol-relative destinations", () => {
    expect(safeReturnPath("https://evil.example/steal")).toBe("/");
    expect(safeReturnPath("//evil.example/steal")).toBe("/");
    expect(safeReturnPath("javascript:alert(1)")).toBe("/");
  });

  test("rejects encoded redirect bypasses and malformed values", () => {
    expect(safeReturnPath("/%2f%2fevil.example")).toBe("/");
    expect(safeReturnPath("/%5cevil.example")).toBe("/");
    expect(safeReturnPath("/%E0%A4%A")).toBe("/");
  });
});
