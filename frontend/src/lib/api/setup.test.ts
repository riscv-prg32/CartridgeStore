import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ApiResponseValidationError } from "./client";
import { getSetupProgress, getSetupStatus } from "./setup";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const status = {
  ok: true,
  state: "INSTALLATION_REQUIRED",
  setup_required: true,
  authorization_required: true,
  infrastructure: { ready: true, fastify: true, canonical_sqlite: true, storage: true, writer_lease: true, secret_registry: true, bootstrap_authorization: true, mdns_infrastructure_allowed: false },
  public_origins: { store: "https://store.example.test", api: "https://api.example.test" },
  mdns: { infrastructure_allowed: false, application_enabled: false, effective_enabled: false, service_type: "_prg32store._tcp.local.", abi: "prg32-store-discovery-1.0", port: 5080, restart_required: true },
};

describe("setup API boundary validation", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  test("accepts the documented status shape", async () => {
    vi.mocked(fetch).mockResolvedValue(response(status));
    await expect(getSetupStatus()).resolves.toMatchObject({ state: "INSTALLATION_REQUIRED", mdns: { port: 5080 } });
  });

  test("rejects malformed status and progress shapes", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...status, state: "UNKNOWN" }));
    await expect(getSetupStatus()).rejects.toBeInstanceOf(ApiResponseValidationError);

    vi.mocked(fetch).mockResolvedValueOnce(response({ ok: true, completed_steps: [] }));
    await expect(getSetupProgress()).rejects.toBeInstanceOf(ApiResponseValidationError);
  });
});
