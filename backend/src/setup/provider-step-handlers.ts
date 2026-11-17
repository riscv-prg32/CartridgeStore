import type { ProviderInput } from "../federation/provider.js";
import {
  loadSamlMetadata,
  parseSamlMetadata,
  ProviderValidationError,
  validateOidcDiscovery,
  validateParsedSamlMetadata,
} from "./provider-validation.js";
import { SetupError } from "./errors.js";
import {
  setupBooleanValue,
  setupStringValue,
} from "./codecs.js";
import type {
  SetupServiceOptions,
  SetupSession,
  SetupStep,
} from "./service-contracts.js";

/** Collaborators used by setup federation step handlers. */
export interface ProviderStepHandlerContext {
  readonly options: SetupServiceOptions;
  readonly apiOrigin: () => string;
  readonly adminUserId: () => number;
  readonly markStep: (
    session: SetupSession,
    step: SetupStep,
    requestId: string,
  ) => void;
}

/** Handles federation provider mutations submitted by setup steps. */
export class SetupProviderStepHandlers {
  constructor(private readonly context: ProviderStepHandlerContext) {}

  saveOidc(
    session: SetupSession,
    payload: Record<string, unknown>,
    requestId: string,
  ): void {
    if (!setupBooleanValue(payload.enabled, "enabled", false)) {
      this.context.markStep(session, "oidc", requestId);
      return;
    }
    const { options } = this.context;
    if (!options.providers || !options.operations) {
      throw new SetupError(
        "federation_unavailable",
        503,
        "federation administration is unavailable",
      );
    }
    const providerId = setupStringValue(
      payload.provider_id,
      "provider_id",
      64,
      true,
    ) as string;
    const apiOrigin = this.context.apiOrigin();
    const clientAuthMethod =
      setupStringValue(payload.client_auth_method, "client_auth_method", 40) ??
      "client_secret_basic";
    if (
      clientAuthMethod !== "client_secret_basic" &&
      clientAuthMethod !== "client_secret_post" &&
      clientAuthMethod !== "none"
    ) {
      throw new SetupError(
        "setup_invalid_value",
        400,
        "client_auth_method is invalid",
      );
    }
    const clientSecret = setupStringValue(
      payload.client_secret,
      "client_secret",
      16384,
      clientAuthMethod !== "none",
    );
    const discoveryIssuer = setupStringValue(
      payload.discovery_issuer,
      "discovery_issuer",
      512,
    );
    const input: ProviderInput = {
      providerId,
      protocol: "oidc",
      displayName: setupStringValue(
        payload.display_name,
        "display_name",
        160,
        true,
      ) as string,
      issuer: setupStringValue(
        payload.issuer,
        "issuer",
        512,
        true,
      ) as string,
      clientId: setupStringValue(
        payload.client_id,
        "client_id",
        240,
        true,
      ) as string,
      clientAuthMethod,
      ...(discoveryIssuer === undefined ? {} : { discoveryIssuer }),
      redirectUri: `${apiOrigin}/api/auth/oidc/${encodeURIComponent(
        providerId,
      )}/callback`,
      scopes: Array.isArray(payload.scopes)
        ? payload.scopes.filter(
            (item): item is string => typeof item === "string",
          )
        : ["openid", "profile", "email"],
    };
    const actor = this.context.adminUserId();
    const mutationContext = { actorUserId: actor, requestId };
    const created = options.providers.create(input, mutationContext);
    if (clientSecret) {
      options.operations.rotateProviderSecret(
        created.providerId,
        "oidc-client-secret",
        clientSecret,
        mutationContext,
      );
      options.providers.update(
        created.providerId,
        {
          clientSecretReference:
            `federated-provider:${created.providerId}:oidc-client-secret`,
        },
        mutationContext,
      );
    }
    options.operations.setEnabled(
      created.providerId,
      true,
      mutationContext,
    );
    this.context.markStep(session, "oidc", requestId);
  }

  saveSaml(
    session: SetupSession,
    payload: Record<string, unknown>,
    requestId: string,
  ): void {
    if (!setupBooleanValue(payload.enabled, "enabled", false)) {
      this.context.markStep(session, "saml", requestId);
      return;
    }
    const { options } = this.context;
    if (!options.providers || !options.operations) {
      throw new SetupError(
        "federation_unavailable",
        503,
        "federation administration is unavailable",
      );
    }
    const providerId = setupStringValue(
      payload.provider_id,
      "provider_id",
      64,
      true,
    ) as string;
    const apiOrigin = this.context.apiOrigin();
    const idpEntityId = setupStringValue(
      payload.idp_entity_id,
      "idp_entity_id",
      512,
      true,
    ) as string;
    const input: ProviderInput = {
      providerId,
      protocol: "saml",
      displayName: setupStringValue(
        payload.display_name,
        "display_name",
        160,
        true,
      ) as string,
      issuer: idpEntityId,
      idpEntityId,
      spEntityId: `${apiOrigin}/api/auth/saml/${encodeURIComponent(
        providerId,
      )}/metadata`,
      acsUrl: `${apiOrigin}/api/auth/saml/${encodeURIComponent(
        providerId,
      )}/acs`,
      samlEntryPoint: setupStringValue(
        payload.saml_entry_point,
        "saml_entry_point",
        512,
        true,
      ) as string,
      samlNameIdFormat:
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      samlIdpCertificatePem: setupStringValue(
        payload.saml_idp_certificate_pem,
        "saml_idp_certificate_pem",
        65536,
        true,
      ) as string,
      samlWantAssertionsSigned: true,
      samlWantAuthnResponseSigned: true,
      samlSignAuthnRequests: false,
    };
    const actor = this.context.adminUserId();
    const mutationContext = { actorUserId: actor, requestId };
    const created = options.providers.create(input, mutationContext);
    options.operations.setEnabled(
      created.providerId,
      true,
      mutationContext,
    );
    this.context.markStep(session, "saml", requestId);
  }
}

/** Validates provider metadata through the existing setup error contract. */
export async function validateOidcSetup(
  session: SetupSession,
  issuer: string,
  options: SetupServiceOptions,
  requireSession: (session: SetupSession) => void,
): Promise<Record<string, unknown>> {
  requireSession(session);
  try {
    return {
      ok: true,
      discovery: await validateOidcDiscovery(issuer, options.config),
    };
  } catch (error) {
    if (error instanceof ProviderValidationError) {
      throw new SetupError(error.code, 400, error.message);
    }
    throw new SetupError(
      "oidc_metadata_invalid",
      400,
      "OIDC discovery metadata is invalid",
    );
  }
}

/** Imports SAML metadata through the existing setup error contract. */
export async function importSamlSetupMetadata(
  session: SetupSession,
  input: { readonly url?: string; readonly xml?: string },
  options: SetupServiceOptions,
  requireSession: (session: SetupSession) => void,
): Promise<Record<string, unknown>> {
  requireSession(session);
  try {
    const metadata =
      input.xml !== undefined
        ? await validateParsedSamlMetadata(
            parseSamlMetadata(input.xml),
            options.config,
          )
        : input.url !== undefined
          ? await loadSamlMetadata(input.url, options.config)
          : (() => {
              throw new ProviderValidationError(
                "saml_metadata_required",
                "SAML metadata URL or XML is required",
              );
            })();
    return { ok: true, metadata };
  } catch (error) {
    if (error instanceof ProviderValidationError) {
      throw new SetupError(error.code, 400, error.message);
    }
    throw new SetupError(
      "saml_metadata_invalid",
      400,
      "SAML metadata is invalid",
    );
  }
}
