import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { compareContractResponse } from "../src/contract/harness.js";

describe("contract comparison harness", () => {
  it("compares JSON shape, headers, ordering, and status", () => {
    expect(() =>
      compareContractResponse(
        {
          status: 200,
          contentType: "application/json",
          requiredHeaders: ["etag"],
          json: { ok: true, items: [{ id: "synthetic" }] }
        },
        {
          status: 200,
          headers: { "content-type": "application/json", etag: "fixture" },
          body: Buffer.from('{"ok":true,"items":[{"id":"synthetic","extra":1}]}')
        }
      )
    ).not.toThrow();
  });

  it("compares exact bytes and their SHA-256 digest", () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    const digest = crypto.createHash("sha256").update(binary).digest("hex");
    expect(() =>
      compareContractResponse(
        { status: 200, binary, binarySha256: digest },
        { status: 200, headers: {}, body: binary }
      )
    ).not.toThrow();
  });

  it("detects a required field type change", () => {
    expect(() =>
      compareContractResponse(
        { status: 200, json: { ok: true, count: 1 } },
        {
          status: 200,
          headers: {},
          body: Buffer.from('{"ok":true,"count":"1"}')
        }
      )
    ).toThrow("body.count type differs");
  });
});
