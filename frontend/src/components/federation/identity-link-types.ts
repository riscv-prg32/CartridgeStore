/** State captured by the explicit federation identity-link form. */
export type IdentityLinkFormState = {
  protocol: "oidc" | "saml";
  provider_id: string;
  issuer: string;
  subject: string;
  user_id: string;
};
