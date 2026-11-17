import { describe, expect, it } from "vitest";

import { ValidatedExternalIdentity } from "../src/federation/identity.js";
import { FederationLinkChallengeError, FederationLinkChallengeService } from "../src/federation/link-challenges.js";

describe("federation link challenges", () => {
  it("keeps validated subjects private and exposes only bounded metadata", () => {
    const service = new FederationLinkChallengeService();
    const identity = ValidatedExternalIdentity.fromProtocolAdapter({
      protocol: "oidc",
      providerId: "local-oidc",
      issuer: "https://sso.example.test/application/o/prg32/",
      subject: "private-subject-value",
      email: "test@example.test",
      authenticatedAt: new Date().toISOString()
    });

    const challengeId = service.stage(identity, 1_000);
    expect(challengeId).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(service.list(1_001)).toEqual([expect.objectContaining({
      challengeId,
      protocol: "oidc",
      providerId: "local-oidc",
      issuer: "https://sso.example.test/application/o/prg32/"
    })]);
    expect(JSON.stringify(service.list(1_001))).not.toContain("private-subject-value");
    expect(service.get(challengeId, 1_001)).toBe(identity);
  });

  it("expires challenges and bounds the in-memory queue", () => {
    const service = new FederationLinkChallengeService();
    const identity = ValidatedExternalIdentity.fromProtocolAdapter({
      protocol: "saml",
      providerId: "local-saml",
      issuer: "https://sso.example.test/providers/saml/",
      subject: "subject",
      authenticatedAt: new Date().toISOString()
    });
    let first = "";
    for (let index = 0; index < 65; index += 1) {
      const challenge = service.stage(identity, 10_000 + index);
      if (index === 0) first = challenge;
    }
    expect(service.list(10_064)).toHaveLength(64);
    expect(() => service.get(first, 10_064)).toThrowError(FederationLinkChallengeError);
    const current = service.list(10_064)[0];
    expect(current).toBeDefined();
    expect(() => service.get(current?.challengeId ?? "", 10_000 + 64 + 5 * 60 * 1000 + 1)).toThrowError(FederationLinkChallengeError);
  });
});
