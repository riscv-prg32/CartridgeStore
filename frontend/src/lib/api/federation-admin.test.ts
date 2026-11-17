import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { federationAdminApi } from "./federation-admin";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const provider = {
  provider_id: "generic-oidc",
  protocol: "oidc",
  display_name: "Generic OIDC",
  issuer: "https://idp.example.test",
  enabled: false,
  generation: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  client_id: "client",
  discovery_issuer: null,
  redirect_uri: "https://store.example.test/api/auth/oidc/generic-oidc/callback",
  scopes: ["openid"],
  idp_entity_id: null,
  sp_entity_id: null,
  acs_url: null,
  saml_entry_point: null,
  saml_name_id_format: null,
  saml_want_assertions_signed: true,
  saml_want_authn_response_signed: true,
  saml_sign_authn_requests: false,
  saml_accepted_clock_skew_ms: 0,
  client_auth_method: "client_secret_basic",
  client_secret_configured: true,
  configuration_complete: true,
  pending_transactions: 0,
  certificates: [],
  trusted_certificate_count: 0,
  trusted_certificate_capacity: 2,
};

const safeStatus = {
  providerId: "generic-oidc",
  protocol: "oidc",
  displayName: "Generic OIDC",
  enabled: false,
  generation: 2,
  pendingTransactions: 0,
  samlCertificateFingerprints: [],
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("federation administration API client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  test("uses canonical provider URLs and validates safe responses", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: true, providers: [provider] }));
    await expect(federationAdminApi.listProviders()).resolves.toMatchObject({ providers: [{ provider_id: "generic-oidc" }] });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/admin/federation/providers");
  });

  test("forwards same-origin credentials and CSRF for sensitive mutations without placing secrets in URLs", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response({ ok: true, csrf_token: "csrf-token-that-is-long-enough-for-the-contract-123" }));
    fetchMock.mockResolvedValueOnce(response({ ok: true, provider: safeStatus }));
    await federationAdminApi.rotateSecret("generic-oidc", "super-secret-value");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/auth/csrf");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/federation/providers/generic-oidc/rotate-secret");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("X-CSRFToken")).toContain("csrf-token");
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("super-secret-value");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ purpose: "oidc-client-secret", secret: "super-secret-value" });
  });

  test("preserves stable backend error codes", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: false, error: "permission denied", code: "permission_denied" }, 403));
    await expect(federationAdminApi.listProviders()).rejects.toMatchObject({ status: 403, body: { code: "permission_denied" } });
  });

  test("rejects malformed provider responses instead of fabricating missing fields", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ok: true, providers: [{ provider_id: "missing-fields" }] }));
    await expect(federationAdminApi.listProviders()).rejects.toMatchObject({ name: "ApiResponseValidationError" });
  });
});
