import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { StoreClient } from "../src/http.js";
import { CliError } from "../src/errors.js";

const servers: http.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

function server(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const instance = http.createServer(handler).listen(0, "127.0.0.1", () => {
      servers.push(instance);
      const address = instance.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

describe("store HTTP client", () => {
  it("sends bearer authentication and parses bounded JSON", async () => {
    const url = await server((request, response) => {
      expect(request.headers.authorization).toBe("Bearer test-token");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    const result = await new StoreClient({ server: url, token: "test-token", timeoutMs: 1000, json: true, quiet: false, noColor: true, yes: false }).request<{ ok: boolean }>("/health");
    expect(result).toEqual({ ok: true });
  });

  it("maps authorization failures without exposing response internals", async () => {
    const url = await server((_request, response) => { response.statusCode = 403; response.end(JSON.stringify({ ok: false, error: "forbidden", code: "permission_denied" })); });
    await expect(new StoreClient({ server: url, token: "test-token", timeoutMs: 1000, json: true, quiet: false, noColor: true, yes: false }).request("/private")).rejects.toMatchObject({ code: "permission_denied", exitCode: 3 });
  });

  it("rejects non-loopback HTTP servers", () => {
    expect(() => new StoreClient({ server: "http://example.test", timeoutMs: 1000, json: false, quiet: false, noColor: true, yes: false })).toThrowError(CliError);
  });
});
