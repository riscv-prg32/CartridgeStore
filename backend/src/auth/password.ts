import crypto from "node:crypto";

export type PasswordHashFormat =
  | "scrypt"
  | "pbkdf2:sha256"
  | "pbkdf2:sha1";

export type PasswordHashResult =
  | { readonly status: "valid" | "invalid"; readonly format: PasswordHashFormat }
  | { readonly status: "unsupported"; readonly reason: string };

interface ParsedHash {
  readonly format: PasswordHashFormat;
  readonly salt: string;
  readonly digestHex: string;
  readonly parameters: readonly number[];
}

const DEFAULT_SCRYPT = [2 ** 15, 8, 1] as const;
const DEFAULT_PBKDF2_ITERATIONS = 1_000_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;

function unsupported(reason: string): PasswordHashResult {
  return { status: "unsupported", reason };
}

function parseHash(storedHash: string): ParsedHash | PasswordHashResult {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return unsupported("Werkzeug hash must have method, salt, and digest fields");
  }

  const [method, salt, digestHex] = parts;
  const args = method.split(":");
  const baseMethod = args[0];
  if (baseMethod === "scrypt") {
    const parameters = args.length === 1 ? [...DEFAULT_SCRYPT] : args.slice(1).map(Number);
    if (parameters.length !== 3 || parameters.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      return unsupported("scrypt parameters are invalid");
    }
    return { format: "scrypt", salt, digestHex, parameters };
  }

  if (baseMethod === "pbkdf2") {
    const algorithm = args[1] ?? "sha256";
    if (algorithm !== "sha256" && algorithm !== "sha1") {
      return unsupported(`pbkdf2 algorithm ${algorithm} is not supported`);
    }
    const iterations = args[2] === undefined ? DEFAULT_PBKDF2_ITERATIONS : Number(args[2]);
    if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > MAX_PBKDF2_ITERATIONS) {
      return unsupported("pbkdf2 iteration count is outside the compatibility limit");
    }
    if (args.length > 3) {
      return unsupported("pbkdf2 has too many parameters");
    }
    return {
      format: algorithm === "sha256" ? "pbkdf2:sha256" : "pbkdf2:sha1",
      salt,
      digestHex,
      parameters: [iterations]
    };
  }

  return unsupported(`Werkzeug hash method ${baseMethod} is not supported`);
}

function safeEqualHex(expectedHex: string, actual: Buffer): boolean {
  if (!/^[0-9a-f]+$/i.test(expectedHex) || expectedHex.length % 2 !== 0) {
    return false;
  }
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function verifyWerkzeugPasswordHash(storedHash: string, password: string): PasswordHashResult {
  const parsed = parseHash(storedHash);
  if ("status" in parsed) {
    return parsed;
  }

  try {
    let digest: Buffer;
    if (parsed.format === "scrypt") {
      const [N = DEFAULT_SCRYPT[0], r = DEFAULT_SCRYPT[1], p = DEFAULT_SCRYPT[2]] = parsed.parameters;
      digest = crypto.scryptSync(password, parsed.salt, 64, {
        N,
        r,
        p,
        maxmem: Math.max(128 * N * r * p, 132 * N * r * p)
      });
    } else {
      const [iterations = DEFAULT_PBKDF2_ITERATIONS] = parsed.parameters;
      digest = crypto.pbkdf2Sync(
        password,
        parsed.salt,
        iterations,
        parsed.format === "pbkdf2:sha256" ? 32 : 20,
        parsed.format.slice("pbkdf2:".length)
      );
    }

    return {
      status: safeEqualHex(parsed.digestHex, digest) ? "valid" : "invalid",
      format: parsed.format
    };
  } catch {
    return unsupported("password hash parameters could not be evaluated");
  }
}

export function supportedWerkzeugHashFormats(): readonly PasswordHashFormat[] {
  return ["scrypt", "pbkdf2:sha256", "pbkdf2:sha1"];
}
