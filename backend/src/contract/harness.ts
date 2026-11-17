import assert from "node:assert/strict";
import crypto from "node:crypto";

export interface ContractResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: Uint8Array;
}

export interface ContractExpectation {
  readonly status: number;
  readonly contentType?: string;
  readonly requiredHeaders?: readonly string[];
  readonly json?: unknown;
  readonly binary?: Uint8Array;
  readonly binarySha256?: string;
}

function parseJson(body: Uint8Array | undefined): unknown {
  assert.ok(body, "expected a JSON response body");
  return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
}

function assertSameShape(expected: unknown, actual: unknown, path: string): void {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    assert.equal(actual.length, expected.length, `${path} length differs`);
    expected.forEach((value, index) => assertSameShape(value, actual[index], `${path}[${index}]`));
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path} must be an object`);
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expectedRecord)) {
      assert.ok(Object.hasOwn(actualRecord, key), `${path}.${key} is missing`);
      assertSameShape(value, actualRecord[key], `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof actual, typeof expected, `${path} type differs`);
}

export function compareContractResponse(
  expected: ContractExpectation,
  actual: ContractResponse
): void {
  assert.equal(actual.status, expected.status, "status differs");
  if (expected.contentType) {
    assert.equal(actual.headers["content-type"], expected.contentType, "content type differs");
  }
  for (const header of expected.requiredHeaders ?? []) {
    assert.ok(actual.headers[header] !== undefined, `required header ${header} is missing`);
  }
  if (expected.json !== undefined) {
    assertSameShape(expected.json, parseJson(actual.body), "body");
  }
  if (expected.binary) {
    assert.deepEqual(actual.body, expected.binary, "binary payload differs");
  }
  if (expected.binarySha256) {
    assert.equal(
      crypto.createHash("sha256").update(actual.body ?? new Uint8Array()).digest("hex"),
      expected.binarySha256,
      "binary SHA-256 differs"
    );
  }
}
