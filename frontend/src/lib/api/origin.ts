const configuredApiOrigin = process.env.NEXT_PUBLIC_PRG32_API_ORIGIN?.trim();
function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("NEXT_PUBLIC_PRG32_API_ORIGIN must be a valid origin"); }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || (parsed.protocol !== "https:" && process.env.NODE_ENV === "production")) {
    throw new Error("NEXT_PUBLIC_PRG32_API_ORIGIN must be an origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

export const publicApiOrigin = normalizedOrigin(configuredApiOrigin);

export function isDualOriginEnabled(): boolean {
  return publicApiOrigin !== undefined;
}

export function resolvePublicApiUrl(input: RequestInfo | URL): RequestInfo | URL {
  if (publicApiOrigin === undefined) return input;
  if (input instanceof URL) return new URL(input.toString(), publicApiOrigin);
  if (typeof input !== "string") return input;
  if (/^https?:\/\//i.test(input)) return input;
  return new URL(input, publicApiOrigin).toString();
}

export function publicApiPath(path: string): string {
  if (publicApiOrigin === undefined) return path;
  return new URL(path, publicApiOrigin).toString();
}
