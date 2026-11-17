import type { z } from "zod";

import {
  federationIdentitySchema,
  federationProviderSchema,
} from "./schemas";

/** Parsed federation provider returned by the administration API. */
export type FederationProvider = z.infer<typeof federationProviderSchema>;

/** Parsed external identity link returned by the administration API. */
export type FederationIdentity = z.infer<typeof federationIdentitySchema>;

/** Supported federation protocols. */
export type FederationProtocol = FederationProvider["protocol"];

/** Provider fields accepted by create and update operations. */
export type FederationProviderInput = {
  provider_id: string;
  protocol: FederationProtocol;
  display_name: string;
  issuer: string;
  client_id?: string;
  client_auth_method?: FederationProvider["client_auth_method"];
  client_secret?: string;
  discovery_issuer?: string;
  redirect_uri?: string;
  scopes?: string[];
  idp_entity_id?: string;
  sp_entity_id?: string;
  acs_url?: string;
  saml_entry_point?: string;
  saml_name_id_format?: string;
  saml_idp_certificate_pem?: string;
  saml_trusted_certificates_pem?: string[];
  saml_want_assertions_signed?: boolean;
  saml_want_authn_response_signed?: boolean;
  saml_sign_authn_requests?: boolean;
  saml_accepted_clock_skew_ms?: number;
};
