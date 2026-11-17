import {
  createProvider,
  disableProvider,
  enableProvider,
  getProvider,
  getProviderStatus,
  listProviders,
  reauthenticate,
  revokeTransactions,
  rotateSecret,
  updateCertificates,
  updateProvider,
} from "./providers";
import {
  linkIdentity,
  listIdentities,
  retireIdentity,
} from "./identities";

export * from "./errors";
export * from "./schemas";
export * from "./types";

/** Stable facade used by federation administration workspaces. */
export const federationAdminApi = {
  listProviders,
  getProvider,
  getProviderStatus,
  reauthenticate,
  createProvider,
  updateProvider,
  enableProvider,
  disableProvider,
  rotateSecret,
  updateCertificates,
  revokeTransactions,
  listIdentities,
  linkIdentity,
  retireIdentity,
};
