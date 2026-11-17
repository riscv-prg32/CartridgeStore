import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateOidcContract, validatePreflightConfiguration, validateSamlContract } from "../src/preflight/config.js";

function candidateEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    PRG32_BACKEND_CANDIDATE_MODE: "two-service-disposable",
    PRG32_BACKEND_CANONICAL_STORAGE_ROOT: "/disposable/canonical",
    PRG32_BACKEND_DB: "/disposable/canonical/store.sqlite",
    PRG32_BACKEND_STORE_DATA: "/disposable/canonical",
    PRG32_BACKEND_AUTH_WRITE_ENABLED: "true",
    PRG32_BACKEND_AUTH_WRITE_MODE: "test",
    PRG32_BACKEND_AUTH_WRITE_DB: "/disposable/canonical/store.sqlite",
    PRG32_BACKEND_AUTH_DISPOSABLE_ROOT: "/disposable/canonical",
    PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: "https://store.prg32.test",
    PRG32_BACKEND_FEDERATION_PUBLIC_ORIGIN: "https://api.prg32.test",
    PRG32_BACKEND_OIDC_PUBLIC_ORIGIN: "https://api.prg32.test",
    PRG32_BACKEND_MDNS_ENABLED: "false",
    PRG32_BACKEND_BACKUP_ENABLED: "false",
    PRG32_BACKEND_SESSION_SECRET: "candidate-session-secret-that-is-longer-than-32-bytes",
    ...overrides
  };
}

describe("configuration preflight", () => {
  it("accepts a disposable canonical candidate without touching paths", () => {
    const result = validatePreflightConfiguration(candidateEnvironment(), "candidate");
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(result.sensitive.PRG32_BACKEND_SESSION_SECRET).toBe("PRESENT");
  });

  it("rejects legacy fallbacks, mismatched roots and unsafe origins", () => {
    const result = validatePreflightConfiguration(candidateEnvironment({
      PRG32_STORE_DB: "/legacy/store.sqlite",
      PRG32_BACKEND_STORE_DATA: "/disposable/other",
      PRG32_BACKEND_FRONTEND_PUBLIC_ORIGIN: "http://store.prg32.test/login"
    }), "candidate");
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => check.status === "FAIL").map((check) => check.id)).toEqual(expect.arrayContaining([
      "canonical_paths",
      "legacy_fallbacks_disabled",
      "public_origins_https"
    ]));
  });

  it("rejects an enabled candidate writer without a session secret", () => {
    const result = validatePreflightConfiguration(candidateEnvironment({ PRG32_BACKEND_SESSION_SECRET: undefined }), "candidate");
    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.id === "candidate_session_secret")?.status).toBe("FAIL");
    expect(result.sensitive.PRG32_BACKEND_SESSION_SECRET).toBe("MISSING");
  });

  it("recognizes protected file-backed session and bootstrap secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prg32-preflight-secrets-"));
    try {
      const sessionPath = path.join(root, "session-secret");
      const bootstrapPath = path.join(root, "bootstrap-token");
      fs.writeFileSync(
        sessionPath,
        "session-secret-file-value-012345678901234567890\n",
        { mode: 0o600 },
      );
      fs.writeFileSync(
        bootstrapPath,
        "bootstrap-token-file-value-012345678901234567890\n",
        { mode: 0o600 },
      );

      const result = validatePreflightConfiguration(
        candidateEnvironment({
          PRG32_BACKEND_SESSION_SECRET: undefined,
          PRG32_BACKEND_SESSION_SECRET_FILE: sessionPath,
          PRG32_BACKEND_BOOTSTRAP_TOKEN: undefined,
          PRG32_BACKEND_BOOTSTRAP_TOKEN_FILE: bootstrapPath,
        }),
        "candidate",
      );

      expect(result.sensitive.PRG32_BACKEND_SESSION_SECRET).toBe("PRESENT");
      expect(result.sensitive.PRG32_BACKEND_BOOTSTRAP_TOKEN).toBe("PRESENT");
      expect(
        result.checks.find((check) => check.id === "candidate_session_secret")?.status,
      ).toBe("PASS");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous or unsafe file-backed secret references", () => {
    const result = validatePreflightConfiguration(
      candidateEnvironment({
        PRG32_BACKEND_SESSION_SECRET:
          "inline-session-secret-that-is-long-enough-123456",
        PRG32_BACKEND_SESSION_SECRET_FILE: "relative/session-secret",
      }),
      "candidate",
    );

    expect(result.sensitive.PRG32_BACKEND_SESSION_SECRET).toBe(
      "INVALID_REFERENCE",
    );
  });

  it("never returns secret values in its machine-readable result", () => {
    const secret = "super-secret-value-that-must-not-appear-in-output";
    const result = validatePreflightConfiguration(candidateEnvironment({ PRG32_BACKEND_SESSION_SECRET: secret }), "candidate");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.sensitive.PRG32_BACKEND_SESSION_SECRET).toBe("PRESENT");
  });
});

describe("federation configuration preflight", () => {
  it("accepts generic OIDC relationships without provider-specific assumptions", () => {
    const checks = validateOidcContract({
      providerId: "generic",
      issuer: "https://idp.example.test",
      discoveryEndpoint: "https://idp.example.test/.well-known/openid-configuration",
      jwksUri: "https://idp.example.test/jwks",
      clientId: "prg32-store",
      clientAuthMethod: "none",
      redirectUri: "https://api.prg32.test/api/auth/oidc/generic/callback",
      scopes: ["openid", "profile", "email"],
      pkce: true,
      state: true,
      nonce: true
    }, "https://api.prg32.test");
    expect(checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("rejects OIDC callbacks on the storefront origin", () => {
    const checks = validateOidcContract({
      providerId: "generic",
      issuer: "https://idp.example.test",
      discoveryEndpoint: "https://idp.example.test/.well-known/openid-configuration",
      jwksUri: "https://idp.example.test/jwks",
      clientId: "prg32-store",
      clientAuthMethod: "client_secret_basic",
      redirectUri: "https://store.prg32.test/api/auth/oidc/generic/callback",
      scopes: ["openid"],
      pkce: true,
      state: true,
      nonce: true
    }, "https://api.prg32.test");
    expect(checks.find((check) => check.id === "oidc_callback_bound")?.status).toBe("FAIL");
  });

  it("requires signed SAML responses, assertions and replay protection", () => {
    const checks = validateSamlContract({
      providerId: "generic",
      spEntityId: "https://api.prg32.test/saml/sp",
      acsUrl: "https://api.prg32.test/api/auth/saml/generic/acs",
      idpEntityId: "https://idp.example.test/saml",
      idpSsoUrl: "https://idp.example.test/saml/sso",
      idpSigningCertificateReference: "secret-ref:saml-idp-cert",
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      allowedBinding: "HTTP-POST",
      audience: "https://api.prg32.test/saml/sp",
      destination: "https://api.prg32.test/api/auth/saml/generic/acs",
      recipient: "https://api.prg32.test/api/auth/saml/generic/acs",
      replayProtection: true
    }, "https://api.prg32.test");
    expect(checks.every((check) => check.status === "PASS")).toBe(true);
    const rejected = validateSamlContract({
      providerId: "generic",
      spEntityId: "https://api.prg32.test/saml/sp",
      acsUrl: "https://api.prg32.test/api/auth/saml/generic/acs",
      idpEntityId: "https://idp.example.test/saml",
      idpSsoUrl: "https://idp.example.test/saml/sso",
      idpSigningCertificateReference: "secret-ref:saml-idp-cert",
      wantAssertionsSigned: false,
      wantAuthnResponseSigned: true,
      allowedBinding: "HTTP-POST",
      audience: "https://api.prg32.test/saml/sp",
      destination: "https://api.prg32.test/api/auth/saml/generic/acs",
      recipient: "https://api.prg32.test/api/auth/saml/generic/acs",
      replayProtection: false
    }, "https://api.prg32.test");
    expect(rejected.find((check) => check.id === "saml_signature_policy")?.status).toBe("FAIL");
    expect(rejected.find((check) => check.id === "saml_replay_protection")?.status).toBe("FAIL");
  });
});
