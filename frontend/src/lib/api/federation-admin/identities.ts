import { z } from "zod";

import { requestApiJson } from "../client";
import {
  federationIdentitiesResponseSchema,
  federationIdentityResponseSchema,
} from "./schemas";
import type { FederationProtocol } from "./types";
import { mutate } from "./transport";

const federationMutationResponseSchema = z.object({ ok: z.literal(true) });

export function listIdentities() {
  return requestApiJson(
    "/api/admin/federation/identities",
    undefined,
    federationIdentitiesResponseSchema,
  );
}

export function linkIdentity(input: {
  protocol: FederationProtocol;
  provider_id: string;
  issuer: string;
  subject: string;
  user_id: number;
}) {
  return mutate(
    "/api/admin/federation/identities",
    "POST",
    input,
    federationIdentityResponseSchema,
  );
}

export function retireIdentity(identityId: number) {
  return mutate(
    `/api/admin/federation/identities/${encodeURIComponent(
      identityId,
    )}/retire`,
    "POST",
    {},
    federationMutationResponseSchema,
  );
}
