import crypto from "node:crypto";

/** Generates the Werkzeug-compatible scrypt hash used by local accounts. */
export function generateWerkzeugScryptHash(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 132 * (2 ** 15) * 8 * 1,
  });
  return `scrypt:32768:8:1$${salt}$${digest.toString("hex")}`;
}
