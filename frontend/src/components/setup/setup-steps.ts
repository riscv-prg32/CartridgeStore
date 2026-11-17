import type { SetupStep } from "../../lib/api/setup";

/** Presentation metadata for the first-installation wizard steps. */
export const setupSteps: Array<{
  id: SetupStep;
  label: string;
  optional?: boolean;
}> = [
  { id: "admin", label: "Administrator" },
  { id: "store", label: "Store" },
  { id: "registration", label: "Registration" },
  { id: "security", label: "Security" },
  { id: "smtp", label: "SMTP", optional: true },
  { id: "oidc", label: "OIDC", optional: true },
  { id: "saml", label: "SAML", optional: true },
  { id: "mdns", label: "mDNS", optional: true },
  { id: "review", label: "Review" },
];
