import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { z } from "zod";

import type { passkeyOptionsResponseSchema } from "../api/schemas";

type PasskeyOptionsResponse = z.output<typeof passkeyOptionsResponseSchema>;

/**
 * The backend intentionally transports WebAuthn options as an opaque JSON
 * object. This is the single boundary where that wire value is narrowed to
 * the browser library's protocol types; ceremony ordering remains unchanged.
 */
export function toAuthenticationOptions(response: PasskeyOptionsResponse): PublicKeyCredentialRequestOptionsJSON {
  return response.options as unknown as PublicKeyCredentialRequestOptionsJSON;
}

export function toRegistrationOptions(response: PasskeyOptionsResponse): PublicKeyCredentialCreationOptionsJSON {
  return response.options as unknown as PublicKeyCredentialCreationOptionsJSON;
}
