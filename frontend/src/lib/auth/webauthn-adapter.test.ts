import { describe, expect, test } from "vitest";

import { passkeyOptionsResponseSchema } from "../api/schemas";
import { toAuthenticationOptions, toRegistrationOptions } from "./webauthn-adapter";

describe("WebAuthn options adapter", () => {
  test("keeps the validated opaque protocol payload unchanged", () => {
    const response = passkeyOptionsResponseSchema.parse({
      ok: true,
      options: { challenge: "synthetic-challenge", rp: { id: "store.example.test" } },
    });

    expect(toAuthenticationOptions(response)).toEqual(response.options);
    expect(toRegistrationOptions(response)).toEqual(response.options);
  });
});
