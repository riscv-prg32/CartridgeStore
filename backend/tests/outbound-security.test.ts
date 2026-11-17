import http from "node:http";

import { describe, expect, it } from "vitest";

import { isForbiddenAddress, resolveOutboundHost, fetchBoundedText } from "../src/setup/outbound.js";
import { loadConfig } from "../src/config/env.js";

function config(allowlist = "") {
  return loadConfig({
    NODE_ENV: "test",
    PRG32_BACKEND_SETUP_NETWORK_TEST_ALLOWLIST: allowlist,
    PRG32_BACKEND_SESSION_SECRET: "outbound-security-test-session-secret",
    PRG32_BACKEND_BOOTSTRAP_TOKEN: "outbound-security-test-bootstrap-token"
  });
}

describe("outbound network security", () => {
  it("rejects private and link-local DNS answers unless the hostname is explicitly allowlisted", async () => {
    expect(isForbiddenAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenAddress("::1")).toBe(true);
    const lookup = () => Promise.resolve([{ address: "198.51.100.10", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(resolveOutboundHost("provider.example", 443, config(), { lookup })).rejects.toMatchObject({ code: "provider_private_target_denied" });
    const accepted = await resolveOutboundHost("provider.example", 443, config("provider.example"), { lookup });
    expect(accepted.allowlisted).toBe(true);
  });

  it("pins the connection lookup to the validated address and bounds response bodies", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ issuer: "https://provider.example" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const lookup = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
      const target = await resolveOutboundHost("provider.example", port, config("provider.example"), { lookup });
      expect(target.address).toBe("127.0.0.1");
      const response = await fetchBoundedText(`http://provider.example:${port}/metadata`, config("provider.example"), {
        allowedProtocols: ["http:"],
        lookup,
        maxBytes: 1024
      });
      expect(response.text).toContain("provider.example");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps HTTPS as the default provider metadata protocol", async () => {
    await expect(fetchBoundedText("http://provider.example/metadata", config("provider.example"))).rejects.toMatchObject({ code: "provider_https_required" });
  });
});
