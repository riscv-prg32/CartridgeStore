import crypto from "node:crypto";

import type { FederationProtocol } from "./provider.js";
import type { ValidatedExternalIdentity } from "./identity.js";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 64;

export class FederationLinkChallengeError extends Error {
  constructor(readonly code: "federation_link_challenge_invalid" | "federation_link_challenge_expired", readonly statusCode: 400 | 410, message: string) {
    super(message);
    this.name = "FederationLinkChallengeError";
  }
}

interface PendingLinkChallenge {
  readonly identity: ValidatedExternalIdentity;
  readonly protocol: FederationProtocol;
  readonly providerId: string;
  readonly issuer: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface LinkChallengeView {
  readonly challengeId: string;
  readonly protocol: FederationProtocol;
  readonly providerId: string;
  readonly issuer: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Holds validated identities between a protocol callback and an explicit
 * administrator link. The subject and claims never leave this process.
 * Challenges are deliberately disposable: a restart invalidates them.
 */
export class FederationLinkChallengeService {
  private readonly challenges = new Map<string, PendingLinkChallenge>();

  stage(identity: ValidatedExternalIdentity, now = Date.now()): string {
    this.prune(now);
    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
    const challengeId = crypto.randomBytes(32).toString("base64url");
    const value = identity.value;
    this.challenges.set(challengeId, {
      identity,
      protocol: value.protocol,
      providerId: value.providerId,
      issuer: value.issuer,
      createdAt: now,
      expiresAt: now + CHALLENGE_TTL_MS
    });
    return challengeId;
  }

  list(now = Date.now()): readonly LinkChallengeView[] {
    this.prune(now);
    return [...this.challenges.entries()].map(([challengeId, challenge]) => ({
      challengeId,
      protocol: challenge.protocol,
      providerId: challenge.providerId,
      issuer: challenge.issuer,
      createdAt: new Date(challenge.createdAt).toISOString(),
      expiresAt: new Date(challenge.expiresAt).toISOString()
    }));
  }

  get(challengeId: string, now = Date.now()): ValidatedExternalIdentity {
    this.prune(now);
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new FederationLinkChallengeError("federation_link_challenge_invalid", 400, "federation link challenge is invalid");
    if (challenge.expiresAt <= now) {
      this.challenges.delete(challengeId);
      throw new FederationLinkChallengeError("federation_link_challenge_expired", 410, "federation link challenge expired");
    }
    return challenge.identity;
  }

  remove(challengeId: string): void {
    this.challenges.delete(challengeId);
  }

  private prune(now: number): void {
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(challengeId);
    }
  }
}
